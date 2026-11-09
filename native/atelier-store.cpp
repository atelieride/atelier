/*
 * atelier-store: the Microsoft Store's updates for Atelier. Main runs it
 * from resources\bin with a fixed argv (src/main/store-updates.ts); as a child of the packaged Atelier.exe it has the
 * package's identity, which StoreContext needs. No shell, no network of its own (the Store service downloads).
 *
 *   atelier-store check    family <family name>
 *                          registered <a.b.c.d>   the newest version of the package registered for this user
 *                          updates <n>            Store updates for the package
 *                          silent <0|1>           the Store allows a silent download (automatic updates on, not metered)
 *   atelier-store update   progress <0.000..1.000> while it downloads and installs (TrySilentDownloadAndInstall…)
 *                          done completed|none|canceled|error|low-battery|wifi
 *                          Refused before Windows 11 24H2 (build 26100): only there does Windows leave the running
 *                          Atelier alone while it installs (UpdateWhileInUse=defer); main checks it too.
 *
 * Any failure: "error <hresult as 8 hex digits> <message>" and exit code 1.
 */
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <appmodel.h>
#include <stdio.h>
#include <string.h>
#include <atomic>
#include <memory>
#include <string>
#include <vector>
#include <winrt/Windows.ApplicationModel.h>
#include <winrt/Windows.Foundation.h>
#include <winrt/Windows.Foundation.Collections.h>
#include <winrt/Windows.Services.Store.h>

#pragma comment(lib, "windowsapp.lib")

using winrt::Windows::Services::Store::StoreContext;
using winrt::Windows::Services::Store::StorePackageUpdateState;
using winrt::Windows::Services::Store::StorePackageUpdateStatus;

static void put_line(const char *tag, const wchar_t *w) {
  int n = WideCharToMultiByte(CP_UTF8, 0, w, -1, NULL, 0, NULL, NULL);
  std::string s(n > 0 ? (size_t)n : 1, '\0');
  if (n > 0) WideCharToMultiByte(CP_UTF8, 0, w, -1, &s[0], n, NULL, NULL);
  /* One value per line: a message holding a newline is flattened. */
  for (char &c : s) if (c == '\n' || c == '\r') c = ' ';
  printf("%s %s\n", tag, s.c_str());
  fflush(stdout);
}

static int fail(HRESULT hr, const wchar_t *message) {
  char tag[32];
  snprintf(tag, sizeof tag, "error %08lx", (unsigned long)hr);
  put_line(tag, message);
  return 1;
}

/* The newest version among the family's packages registered for this user (an old one stays while it runs). */
static bool newest_registered(const wchar_t *family, PACKAGE_VERSION *out) {
  std::vector<PWSTR> names;
  std::vector<WCHAR> buffer;
  UINT32 count = 0;
  /* The list can grow between the size query and the read (a Store install registering the new version): ask again. */
  for (int attempt = 0;; attempt++) {
    UINT32 length = 0;
    count = 0;
    if (GetPackagesByPackageFamily(family, &count, NULL, &length, NULL) != ERROR_INSUFFICIENT_BUFFER || count == 0) return false;
    names.assign(count, NULL);
    buffer.assign(length, 0);
    LONG rc = GetPackagesByPackageFamily(family, &count, names.data(), &length, buffer.data());
    if (rc == ERROR_SUCCESS) break;
    if (rc != ERROR_INSUFFICIENT_BUFFER || attempt == 3) return false;
  }
  bool found = false;
  for (UINT32 i = 0; i < count; i++) {
    UINT32 size = 0;
    if (PackageIdFromFullName(names[i], PACKAGE_INFORMATION_BASIC, &size, NULL) != ERROR_INSUFFICIENT_BUFFER || size == 0) continue;
    /* PACKAGE_ID holds pointers and a UINT64: a buffer of UINT64 keeps it aligned. */
    std::vector<UINT64> id((size + sizeof(UINT64) - 1) / sizeof(UINT64));
    if (PackageIdFromFullName(names[i], PACKAGE_INFORMATION_BASIC, &size, reinterpret_cast<BYTE *>(id.data())) != ERROR_SUCCESS) continue;
    PACKAGE_VERSION v = reinterpret_cast<PACKAGE_ID *>(id.data())->version;
    if (!found || v.Version > out->Version) { *out = v; found = true; }
  }
  return found;
}

/* Windows' real build number (RtlGetVersion: GetVersionEx lies to apps without a manifest saying otherwise). */
static DWORD windows_build() {
  typedef LONG (WINAPI *RtlGetVersionFn)(OSVERSIONINFOW *);
  HMODULE ntdll = GetModuleHandleW(L"ntdll.dll");
  RtlGetVersionFn get = ntdll ? reinterpret_cast<RtlGetVersionFn>(reinterpret_cast<void *>(GetProcAddress(ntdll, "RtlGetVersion"))) : NULL;
  OSVERSIONINFOW v{};
  v.dwOSVersionInfoSize = sizeof v;
  return get && get(&v) == 0 ? v.dwBuildNumber : 0;
}

static int check() {
  auto family = winrt::Windows::ApplicationModel::Package::Current().Id().FamilyName();
  StoreContext store = StoreContext::GetDefault();
  auto updates = store.GetAppAndOptionalStorePackageUpdatesAsync().get();
  put_line("family", family.c_str());
  PACKAGE_VERSION v{};
  if (newest_registered(family.c_str(), &v)) printf("registered %u.%u.%u.%u\n", v.Major, v.Minor, v.Build, v.Revision);
  printf("updates %u\n", updates.Size());
  printf("silent %d\n", store.CanSilentlyDownloadStorePackageUpdates() ? 1 : 0);
  fflush(stdout);
  return 0;
}

static const char *state_word(StorePackageUpdateState s) {
  switch (s) {
    case StorePackageUpdateState::Completed: return "completed";
    case StorePackageUpdateState::Canceled: return "canceled";
    case StorePackageUpdateState::ErrorLowBattery: return "low-battery";
    case StorePackageUpdateState::ErrorWiFiRecommended:
    case StorePackageUpdateState::ErrorWiFiRequired: return "wifi";
    default: return "error";
  }
}

static int update() {
  if (windows_build() < 26100) return fail(HRESULT_FROM_WIN32(ERROR_NOT_SUPPORTED), L"installing while Atelier runs needs Windows 11 24H2");
  StoreContext store = StoreContext::GetDefault();
  auto updates = store.GetAppAndOptionalStorePackageUpdatesAsync().get();
  if (updates.Size() == 0) { printf("done none\n"); return 0; }
  auto op = store.TrySilentDownloadAndInstallStorePackageUpdatesAsync(updates);
  // Progress arrives on a pool thread, possibly after get() returned; printed only when it moved by a percent (the Store
  // repeats values). The counter is shared, never a reference to this frame.
  auto last = std::make_shared<std::atomic<int>>(-1);
  op.Progress([last](auto const &, StorePackageUpdateStatus const &s) {
    double p = s.TotalDownloadProgress;
    int pct = p < 0 ? 0 : p > 1 ? 100 : (int)(p * 100);
    if (last->exchange(pct) == pct) return;
    printf("progress %.3f\n", pct / 100.0);
    fflush(stdout);
  });
  auto result = op.get();
  printf("done %s\n", state_word(result.OverallState()));
  fflush(stdout);
  return result.OverallState() == StorePackageUpdateState::Completed ? 0 : 1;
}

int wmain(int argc, wchar_t **argv) {
  if (argc != 2) return fail(E_INVALIDARG, L"usage: atelier-store check|update");
  try {
    winrt::init_apartment(winrt::apartment_type::multi_threaded);
    if (!wcscmp(argv[1], L"check")) return check();
    if (!wcscmp(argv[1], L"update")) return update();
    return fail(E_INVALIDARG, L"usage: atelier-store check|update");
  } catch (winrt::hresult_error const &e) {
    return fail(e.code(), e.message().c_str());
  } catch (...) {
    return fail(E_FAIL, L"unexpected failure");
  }
}
