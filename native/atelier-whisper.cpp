// atelier-whisper: local transcription for Atelier. Loads the model once and serves requests on stdin/stdout.
// Request (little endian): "AWR1" | u32 id | u8 lang_len | lang | u32 prompt_len | prompt (UTF-8) | u32 n | n × i16 (16 kHz mono)
// Response: one JSON line per request: {"id":N,"text":"…","noSpeech":0.12,"ms":830} or {"id":N,"error":"…"}.
// At startup: {"ready":true,"ms":…} or {"error":"…"} and exits with 1. No network, no files except the model.
#include "whisper.h"
#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <string>
#include <vector>
#ifdef _WIN32
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <shellapi.h>
#include <fcntl.h>
#include <io.h>
#include <thread>
#endif

// Threads: 8 on a Mac (Metal does the work); on Windows (CPU) as many cores as there are, at most 8.
#ifdef _WIN32
static const int THREADS = std::thread::hardware_concurrency() >= 1 && std::thread::hardware_concurrency() < 8 ? (int)std::thread::hardware_concurrency() : 8;
#else
static const int THREADS = 8;
#endif

static bool read_exact(void *buf, size_t n) { return fread(buf, 1, n, stdin) == n; }
static bool read_u32(uint32_t &v) { uint8_t b[4]; if (!read_exact(b, 4)) return false; v = b[0] | (b[1] << 8) | (b[2] << 16) | ((uint32_t)b[3] << 24); return true; }

static std::string json_escape(const std::string &s) {
  std::string o;
  for (unsigned char c : s) {
    switch (c) {
      case '"': o += "\\\""; break;
      case '\\': o += "\\\\"; break;
      case '\n': o += "\\n"; break;
      case '\r': o += "\\r"; break;
      case '\t': o += "\\t"; break;
      default:
        if (c < 0x20) { char b[8]; snprintf(b, sizeof b, "\\u%04x", c); o += b; } else o += (char)c;
    }
  }
  return o;
}

static void quiet_log(enum ggml_log_level, const char *, void *) {}

#ifdef _WIN32
// The model's path as UTF-8, which whisper.cpp expects on Windows too (it converts it to UTF-16 to open the file).
// The narrow argv is in the ANSI code page: a profile folder like C:\Users\Zoë would reach whisper.cpp as bytes
// that are not UTF-8, and its conversion throws. The wide command line has the real characters.
static std::string model_arg_utf8() {
  int argc = 0;
  LPWSTR *w = CommandLineToArgvW(GetCommandLineW(), &argc);
  std::string out;
  if (!w) return out;
  for (int i = 1; i + 1 < argc; i++) {
    if (wcscmp(w[i], L"--model") != 0) continue;
    int n = WideCharToMultiByte(CP_UTF8, 0, w[i + 1], -1, nullptr, 0, nullptr, nullptr);
    if (n > 1) { out.resize((size_t)n - 1); WideCharToMultiByte(CP_UTF8, 0, w[i + 1], -1, &out[0], n, nullptr, nullptr); }
  }
  LocalFree(w);
  return out;
}

#ifndef PF_AVX2_INSTRUCTIONS_AVAILABLE
#define PF_AVX2_INSTRUCTIONS_AVAILABLE 40
#endif
#endif

int main(int argc, char **argv) {
#ifdef _WIN32
  // Audio arrives as raw bytes: no text-mode CRLF translation on stdin (nor on our JSON lines).
  _setmode(_fileno(stdin), _O_BINARY);
  _setmode(_fileno(stdout), _O_BINARY);
#endif
  const char *model = nullptr;
  for (int i = 1; i + 1 < argc; i++) if (!strcmp(argv[i], "--model")) model = argv[i + 1];
  if (!model) { printf("{\"error\":\"missing --model\"}\n"); return 1; }
#ifdef _WIN32
  // whisper.cpp is built for AVX2 (GGML_AVX2): without it the engine would die on an illegal instruction, unexplained.
  if (!IsProcessorFeaturePresent(PF_AVX2_INSTRUCTIONS_AVAILABLE)) { printf("{\"error\":\"This processor has no AVX2, which dictation needs\"}\n"); fflush(stdout); return 1; }
  const std::string model_utf8 = model_arg_utf8();
  if (!model_utf8.empty()) model = model_utf8.c_str();
#endif
  whisper_log_set(quiet_log, nullptr);
  auto t0 = std::chrono::steady_clock::now();
  whisper_context_params cp = whisper_context_default_params();
  cp.use_gpu = true;
  whisper_context *ctx = whisper_init_from_file_with_params(model, cp);
  if (!ctx) { printf("{\"error\":\"cannot load model\"}\n"); fflush(stdout); return 1; }
  // Warm-up: one second of silence compiles the Metal functions right away, so the first real dictation is fast.
  {
    std::vector<float> silence(16000, 0.0f);
    whisper_full_params wp = whisper_full_default_params(WHISPER_SAMPLING_GREEDY);
    wp.print_progress = false; wp.print_realtime = false; wp.print_timestamps = false; wp.no_timestamps = true;
    wp.language = "en"; wp.audio_ctx = 256; wp.n_threads = THREADS;
    whisper_full(ctx, wp, silence.data(), (int)silence.size());
  }
  long load_ms = (long)std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now() - t0).count();
  printf("{\"ready\":true,\"ms\":%ld}\n", load_ms); fflush(stdout);

  for (;;) {
    char magic[4];
    if (!read_exact(magic, 4)) break;  // stdin closed: exit
    if (memcmp(magic, "AWR1", 4) != 0) { printf("{\"error\":\"bad magic\"}\n"); fflush(stdout); return 2; }
    uint32_t id = 0, plen = 0, n = 0; uint8_t llen = 0;
    if (!read_u32(id) || !read_exact(&llen, 1)) return 2;
    std::string lang(llen, '\0');
    if (llen && !read_exact(&lang[0], llen)) return 2;
    if (!read_u32(plen) || plen > 4096) return 2;
    std::string prompt(plen, '\0');
    if (plen && !read_exact(&prompt[0], plen)) return 2;
    if (!read_u32(n) || n > 16000u * 60u * 6u) return 2;  // 6 minutes at most
    std::vector<int16_t> pcm(n);
    if (n && !read_exact(pcm.data(), n * 2)) return 2;
    std::vector<float> f(n);
    for (uint32_t i = 0; i < n; i++) f[i] = pcm[i] / 32768.0f;

    auto t1 = std::chrono::steady_clock::now();
    whisper_full_params p = whisper_full_default_params(WHISPER_SAMPLING_BEAM_SEARCH);
    p.beam_search.beam_size = 5;
    p.print_progress = false; p.print_realtime = false; p.print_timestamps = false; p.print_special = false;
    p.translate = false;
    p.no_timestamps = true;
    p.single_segment = false;
    p.suppress_nst = true;
    p.language = lang.empty() ? "auto" : lang.c_str();
    p.detect_language = false;
    p.initial_prompt = prompt.empty() ? nullptr : prompt.c_str();
    p.n_threads = THREADS;
    // Encoder window proportional to the audio (Whisper always pads it to 30 s): measured on 10/10 on an M4,
    // 2.6 s → 0.64 s for 5 s of speech with almost the same quality. Beyond ~16 s the full window is used.
    { int ctxw = (int)(n / 16000.0 * 50.0 * 1.5) + 256; p.audio_ctx = ctxw < 1500 ? ctxw : 0; }
    if (whisper_full(ctx, p, f.data(), (int)n) != 0) { printf("{\"id\":%u,\"error\":\"transcription failed\"}\n", id); fflush(stdout); continue; }
    // Text and no-speech probability per segment (whisper.cpp computes it per 30 s window): the caller discards
    // only the silent segments. NaN becomes 0 (the JSON stays valid).
    std::string text, segjson; float ns = 0; int segs = whisper_full_n_segments(ctx);
    for (int i = 0; i < segs; i++) {
      const char *st = whisper_full_get_segment_text(ctx, i);
      float x = whisper_full_get_segment_no_speech_prob(ctx, i);
      if (!std::isfinite(x)) x = 0;
      if (x > ns) ns = x;
      text += st;
      char nb[32]; snprintf(nb, sizeof nb, "%.3f", x);
      segjson += std::string(i ? "," : "") + "{\"text\":\"" + json_escape(st) + "\",\"noSpeech\":" + nb + "}";
    }
    long ms = (long)std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now() - t1).count();
    const char *dl = whisper_lang_str(whisper_full_lang_id(ctx));
    printf("{\"id\":%u,\"text\":\"%s\",\"noSpeech\":%.3f,\"segments\":[%s],\"language\":\"%s\",\"ms\":%ld}\n", id, json_escape(text).c_str(), ns, segjson.c_str(), dl ? dl : "", ms);
    fflush(stdout);
  }
  whisper_free(ctx);
  return 0;
}
