#!/usr/bin/perl
# Fake claude for tests: sends events through the real bridges, as Claude Code would with --settings.
# It is in Perl because a process that is not a shell must show up in the foreground.
use strict; use warnings;
$| = 1;
my $home = $ENV{ATELIER_HOME};
my $hook = "$home/bin/atelier-hook";
my $status = "$home/bin/atelier-statusline";
# Like Claude Code, a resumed conversation keeps its session id; ATELIER_FAKE_SESSION_ID sets one for a new session.
my $resume = ''; for my $i (0..$#ARGV) { $resume = $ARGV[$i+1] if $ARGV[$i] eq '--resume' && defined $ARGV[$i+1]; }
my $sid = $resume || $ENV{ATELIER_FAKE_SESSION_ID} || "fake-$$";
# Reset in 2 hours (5h window) and in 3 days (7d): the meter shows the time left for both.
my $r5 = time() + 2 * 3600 + 120; my $r7 = time() + 3 * 86400 + 4 * 3600 + 120;
# ATELIER_FAKE_5H="<pct>:<seconds to reset>" sets the 5h window (spec usage per config dir: one account per config dir).
my $p5 = 42; ($p5, $r5) = ($1, time() + $2) if ($ENV{ATELIER_FAKE_5H} // '') =~ /^(\d+):(\d+)$/;
# Like Claude Code: the transcript lives under the config dir ($CLAUDE_CONFIG_DIR, else ~/.claude); only the path is sent.
# The default is the tests' fake home (ATELIER_TEST_CLAUDE_HOME), as the app sees it: the default Claude account.
my $tp = ($ENV{CLAUDE_CONFIG_DIR} || ($ENV{ATELIER_TEST_CLAUDE_HOME} || $ENV{HOME}) . '/.claude') . '/projects/' . (Cwd::getcwd() =~ s{[^A-Za-z0-9]}{-}gr) . "/$sid.jsonl";
$tp =~ s/(["\\])/\\$1/g;
sub pipe_to { my ($cmd, $s) = @_; open(my $h, '|-', $cmd) or die; print $h $s; close $h; }
# The session's custom title (JSON-escaped), as Claude Code keeps it: from -n/--name, a /rename ("ev:rename:<name>")
# or a hook's reply (hookSpecificOutput.sessionTitle, session name sync); and its AI title ("ev:ai:<title>").
my $title = ''; for my $i (0..$#ARGV) { $title = $ARGV[$i+1] if $ARGV[$i] eq '-n'; $title = $1 if $ARGV[$i] =~ /^--name=(.*)$/s; }
$title =~ s/(["\\])/\\$1/g;
my $ai = '';
# Like Claude Code: the hook's output is read, and a sessionTitle in it renames the session.
use IPC::Open2 ();
sub send_hook {
  my $pid = IPC::Open2::open2(my $out, my $in, $hook);
  print $in $_[0]; close $in;
  my $reply = do { local $/; <$out> } // '';
  close $out; waitpid($pid, 0);
  $title = $1 if $reply =~ /"sessionTitle":"((?:[^"\\]|\\.)*)"/;
  return $reply;
}
# The status line's session_name: the custom title, else the AI title.
sub send_status {
  my $name = length $title ? $title : $ai;
  my $sn = length $name ? qq("session_name":"$name",) : '';
  pipe_to("$status >/dev/null", qq({"session_id":"$sid","transcript_path":"$tp",$sn$_[0]}));
}
sub title_field { return length $title ? qq(,"session_title":"$title") : ''; }
# ATELIER_FAKE_START_DELAY (seconds): Claude takes this long to start, before its SessionStart (the "starting" session).
# ATELIER_FAKE_START_GATE (a path, opt-in): Claude starts once the test creates that file, which it then removes (the
# next session waits for it again); never more than a minute.
print "FAKE-CLAUDE starting\n" if $ENV{ATELIER_FAKE_START_DELAY} || $ENV{ATELIER_FAKE_START_GATE};
select(undef, undef, undef, $ENV{ATELIER_FAKE_START_DELAY}) if $ENV{ATELIER_FAKE_START_DELAY};
if (my $gate = $ENV{ATELIER_FAKE_START_GATE}) { my $until = time() + 60; select(undef, undef, undef, 0.05) until -e $gate || time() > $until; unlink $gate; }
send_hook(qq({"hook_event_name":"SessionStart","session_id":"$sid","transcript_path":"$tp","source":"@{[$resume ? 'resume' : 'startup']}"@{[title_field()]}}));
send_hook(qq({"hook_event_name":"UserPromptSubmit","session_id":"$sid","prompt":"x"@{[title_field()]}}));
send_hook(qq({"hook_event_name":"PreToolUse","session_id":"$sid","tool_name":"Edit","tool_input":{"file_path":"/p/SpeakerPanel.tsx"}}));
send_status(qq("model":{"id":"claude-opus-5-5","display_name":"Opus 5.5"},"cost":{"total_cost_usd":4.126,"total_lines_added":120,"total_lines_removed":30},"context_window":{"used_percentage":58},"rate_limits":{"five_hour":{"used_percentage":$p5,"resets_at":$r5},"seven_day":{"used_percentage":18,"resets_at":$r7}}));
send_hook(qq({"hook_event_name":"PermissionRequest","session_id":"$sid","tool_name":"Bash","tool_input":{"command":"npm test"}}));
use Cwd ();
# The arguments of a resume (or of every start with ATELIER_FAKE_PRINT_ARGS), without Atelier's --settings (a temporary path).
my @shown; for (my $i = 0; $i <= $#ARGV; $i++) { if ($ARGV[$i] eq '--settings') { $i++; next; } push @shown, $ARGV[$i]; }
print "FAKE-CLAUDE args=@shown\n" if $resume || $ENV{ATELIER_FAKE_PRINT_ARGS};
print "FAKE-CLAUDE cwd=" . Cwd::getcwd() . "\n";
print "FAKE-CLAUDE waiting; press enter\n";
my $line = <STDIN>;
$line = '' unless defined $line; chomp $line; $line =~ s/\r$//;
print "FAKE-CLAUDE got=$line\n" if length $line;
send_hook(qq({"hook_event_name":"PostToolUse","session_id":"$sid","tool_name":"Bash","tool_input":{"command":"npm test"}}));
# "hold": keeps working until the next line; "fail": the turn stops on an error (StopFailure).
if ($line eq 'hold') { print "FAKE-CLAUDE working; press enter\n"; my $more = <STDIN>; }
if ($line eq 'fail') {
  send_hook(qq({"hook_event_name":"StopFailure","session_id":"$sid","error":"rate_limit"}));
  print "FAKE-CLAUDE failed\n";
} else {
  send_hook(qq({"hook_event_name":"Stop","session_id":"$sid"}));
  print "FAKE-CLAUDE done\n";
}
# Then, for 30 seconds after the last line, every line typed into its prompt is printed back (e.g. a slash command
# sent by Atelier). Lines "ev:<what>" send the v2.0 hook events through the same bridge.
my @listeners;
# Background work: the live background shells (id → command, description) in start order, the
# scheduled wake-ups of the next snapshot, and the dev servers started by "serve" (process group leaders).
use POSIX ();
my (%bg, @bg_order, @servers);
my $crons = '[]';
sub js { my ($s) = @_; $s =~ s/(["\\])/\\$1/g; return $s; }
sub bg_list {
  my @ids = @_ ? @_ : @bg_order;
  return join(',', map { my $b = $bg{$_}; my $d = js($b->{description} // $b->{command}); my $c = js($b->{command});
    qq({"id":"$_","type":"shell","status":"running","description":"$d","command":"$c"}) } grep { exists $bg{$_} } @ids);
}
sub bg_add {
  my ($id, $cmd, $desc, $agent) = @_;
  push @bg_order, $id unless grep { $_ eq $id } @bg_order;
  $bg{$id} = { command => $cmd, description => $desc };
  my $who = $agent ? qq("agent_id":"$agent","agent_type":"Explore",) : '';
  my $d = defined $desc ? '"description":"' . js($desc) . '",' : '';
  send_hook(qq({"hook_event_name":"PostToolUse","session_id":"$sid",$who"tool_name":"Bash","tool_input":{"command":") . js($cmd) . qq(",$d"run_in_background":true},"tool_response":{"stdout":"","stderr":"","interrupted":false,"isImage":false,"noOutputExpected":false,"backgroundTaskId":"$id"}}));
}
# The files Claude Code writes for background work, under the test roots: a task's
# output in ATELIER_TEST_CLAUDE_TMP, a subagent's transcript in ATELIER_TEST_CLAUDE_PROJECTS, both keyed by the
# encoded cwd and the session id. (The fake playing Claude Code writes them, never Atelier.)
use File::Path ();
sub enc_cwd { my $c = Cwd::getcwd(); $c =~ s/[^A-Za-z0-9]/-/g; return $c; }
sub task_file { my $d = "$ENV{ATELIER_TEST_CLAUDE_TMP}/" . enc_cwd() . "/$sid/tasks"; File::Path::make_path($d); return "$d/$_[0].output"; }
sub agent_file { my $d = "$ENV{ATELIER_TEST_CLAUDE_PROJECTS}/" . enc_cwd() . "/$sid/subagents"; File::Path::make_path($d); return "$d/agent-$_[0].jsonl"; }
sub session_file { my $d = "$ENV{ATELIER_TEST_CLAUDE_PROJECTS}/" . enc_cwd(); File::Path::make_path($d); return "$d/$sid.jsonl"; }
sub append_file { my ($p, $s) = @_; open(my $h, '>>', $p) or die "$p: $!"; print $h $s; close $h; }
# A transcript line's timestamp: now (UTC), as Claude Code writes them while the agent works.
sub stamp { return POSIX::strftime('%Y-%m-%dT%H:%M:%S.000Z', gmtime()); }
END { kill 'TERM', map { -$_ } @servers if @servers; }
$SIG{HUP} = $SIG{TERM} = sub { exit 0 };
sub ev {
  my ($what) = @_;
  if ($what eq 'question') { send_hook(qq({"hook_event_name":"PreToolUse","session_id":"$sid","tool_name":"AskUserQuestion","tool_input":{"questions":[]}})); }
  elsif ($what eq 'permission') { send_hook(qq({"hook_event_name":"PermissionRequest","session_id":"$sid","tool_name":"Bash","tool_input":{"command":"npm test"}})); }
  elsif ($what eq 'answered') { send_hook(qq({"hook_event_name":"PostToolUse","session_id":"$sid","tool_name":"Bash","tool_input":{"command":"npm test"}})); }
  elsif ($what eq 'compact') { send_hook(qq({"hook_event_name":"PreCompact","session_id":"$sid","trigger":"manual","custom_instructions":""})); }
  elsif ($what eq 'compacted') { send_hook(qq({"hook_event_name":"PostCompact","session_id":"$sid","trigger":"manual","compact_summary":"s"})); }
  elsif ($what =~ /^agents:(\d+)$/) { send_hook(qq({"hook_event_name":"SubagentStart","session_id":"$sid","agent_id":"a$_","agent_type":"Explore"})) for 1..$1; }
  elsif ($what eq 'agent-tool') { send_hook(qq({"hook_event_name":"PreToolUse","session_id":"$sid","agent_id":"a1","agent_type":"Explore","tool_name":"Read","tool_input":{"file_path":"/tmp/x.ts"}})); }
  elsif ($what eq 'agent-done') { send_hook(qq({"hook_event_name":"SubagentStop","session_id":"$sid","agent_id":"a1","agent_type":"Explore"})); }
  elsif ($what =~ /^mode:(\w+)$/) { send_hook(qq({"hook_event_name":"Notification","session_id":"$sid","notification_type":"fake_mode","message":"m","permission_mode":"$1"})); }
  elsif ($what eq 'idle') { send_hook(qq({"hook_event_name":"Notification","session_id":"$sid","notification_type":"idle_prompt","message":"Claude is waiting for your input"})); }
  elsif ($what =~ /^fail:(\w+)$/) { send_hook(qq({"hook_event_name":"StopFailure","session_id":"$sid","error":"$1"})); }
  # "limit": the turn stopped by a usage limit, with Claude Code's words;
  # "notify:<type>": a Notification of that type (quota_auto_resume_fired, …, or one Atelier doesn't know yet).
  elsif ($what eq 'limit') { send_hook(qq({"hook_event_name":"StopFailure","session_id":"$sid","error":"rate_limit","last_assistant_message":"You've hit your session limit · resets 3:45pm"})); }
  elsif ($what =~ /^notify:(\w+)$/) { send_hook(qq({"hook_event_name":"Notification","session_id":"$sid","notification_type":"$1","message":"Claude Code says so"})); }
  elsif ($what eq 'stop') { send_hook(qq({"hook_event_name":"Stop","session_id":"$sid"})); }
  # "session-end": Claude Code's SessionEnd (the terminal has no session any more; this fake keeps reading events).
  elsif ($what eq 'session-end') { send_hook(qq({"hook_event_name":"SessionEnd","session_id":"$sid","reason":"other"})); }
  elsif ($what eq 'work') { send_hook(qq({"hook_event_name":"UserPromptSubmit","session_id":"$sid","prompt":"<task-notification>"})); }
  # Session name sync: "prompt" a message from the user (its hook may hand a name back; the status line then shows the
  # session's name), "rename:<name>" a /rename typed in Claude, "ai:<title>" Claude's AI title arriving.
  elsif ($what eq 'prompt') { send_hook(qq({"hook_event_name":"UserPromptSubmit","session_id":"$sid","prompt":"go on") . title_field() . '}'); send_status('"context_window":{"used_percentage":60}'); }
  elsif ($what =~ /^rename:(.+)$/) { $title = js($1); send_status('"context_window":{"used_percentage":60}'); }
  elsif ($what =~ /^ai:(.+)$/) { $ai = js($1); send_status('"context_window":{"used_percentage":60}'); }
  # "ctx:<n>": the status line reports that much context used.
  elsif ($what =~ /^ctx:(\d+)$/) { send_status(qq("context_window":{"used_percentage":$1})); }
  # Background work: "shell:<id>" a background Bash started (its command runs nowhere, so it stays
  # unmatched and counts until the cap); "cron" a Stop carrying one scheduled wake-up at 12:30 every day.
  elsif ($what =~ /^shell:(\w+)$/) { send_hook(qq({"hook_event_name":"PostToolUse","session_id":"$sid","tool_name":"Bash","tool_input":{"command":"sleep 600 # $1","description":"Running e2e suite $1","run_in_background":true},"tool_response":{"backgroundTaskId":"$1"}})); }
  elsif ($what eq 'cron') {
    $crons = '[{"id":"c1","schedule":"30 12 * * *","recurring":true,"prompt":"check the deploy"}]';
    send_hook(qq({"hook_event_name":"Stop","session_id":"$sid","session_crons":$crons}));
  }
  # Background work as Claude Code reports it (tests/fixtures/hooks/background-*.jsonl). The fake keeps the session's
  # live background shells, so each snapshot lists what a real one would.
  # "bg-shell:<id>[@<agent>]:<cmd>": a background Bash started (by that subagent), PostToolUse with backgroundTaskId.
  elsif ($what =~ /^bg-shell:(\w+)(?:@(\w+))?:(.+)$/) { bg_add($1, $3, undef, $2); }
  # "bg-substop[:<agent>]": the subagent (a1) finished responding: SubagentStop listing the session's shells and itself.
  elsif ($what =~ /^bg-substop(?::(\w+))?$/) {
    my $agent = $1 // 'a1';
    my $tasks = join(',', grep { length } bg_list(), qq({"id":"$agent","type":"subagent","status":"running","description":"Run the test suite","agent_type":"Explore"}));
    send_hook(qq({"hook_event_name":"SubagentStop","session_id":"$sid","agent_id":"$agent","agent_type":"Explore","background_tasks":[$tasks],"session_crons":$crons}));
  }
  # "bg-stop": the main agent's Stop with the session's live shells (the subagents are not listed, as observed);
  # "bg-stop:<id,id>" lists only those.
  elsif ($what =~ /^bg-stop(?::([\w,]*))?$/) {
    my $tasks = bg_list(defined $1 ? (split /,/, $1) : ());
    send_hook(qq({"hook_event_name":"Stop","session_id":"$sid","background_tasks":[$tasks],"session_crons":$crons}));
  }
  # "bg-watch:<id>:<description>": the main agent's Stop listing a monitor without a command, as Claude Code reports the
  # ones it watches itself (an artifact's live updates, an MCP watch): no output file is ever written for it.
  elsif ($what =~ /^bg-watch:(\w+):(.+)$/) {
    my $mon = qq({"id":"$1","type":"monitor","status":"running","description":") . js($2) . qq("});
    my $tasks = join(',', grep { length } bg_list(), $mon);
    send_hook(qq({"hook_event_name":"Stop","session_id":"$sid","background_tasks":[$tasks],"session_crons":$crons}));
  }
  # "bg-notify:<id>": a background task reports back to the main agent (a new turn), and is over.
  elsif ($what =~ /^bg-notify:(\w+)$/) {
    delete $bg{$1};
    send_hook(qq({"hook_event_name":"UserPromptSubmit","session_id":"$sid","prompt":"<task-notification>\\n<task-id>$1</task-id>\\n<status>completed</status>\\n</task-notification>"}));
  }
  # "bg-done:<id>": a background shell ends by itself: no hook fires (its agent is woken instead).
  elsif ($what =~ /^bg-done:(\w+)$/) { delete $bg{$1}; }
  # "cron:<5 fields>": a Stop carrying one scheduled wake-up with that schedule.
  elsif ($what =~ /^cron:([\d*\/,\- ]+)$/) {
    $crons = qq([{"id":"c2","schedule":"$1","recurring":true,"prompt":"check the deploy"}]);
    send_hook(qq({"hook_event_name":"Stop","session_id":"$sid","session_crons":$crons}));
  }
  # A self-paced /loop as Claude Code 2.1.302 runs one (tests/fixtures/hooks/loop-wakeup.jsonl and
  # tests/fixtures/transcripts/loop-wakeup.jsonl): "loop:<seconds>:<id>" writes a ScheduleWakeup and its result to the
  # session's transcript (scheduled on the minute, as observed), then a Stop whose session_crons holds the wake-up as a
  # dateless one-shot with a new id; "loop-stop" writes ScheduleWakeup {stop: true} and a Stop without crons.
  elsif ($what =~ /^loop:(\d+):(\w+)$/) {
    my ($delay, $id) = ($1, $2);
    my $at = int((time() + $delay) / 60) * 60;
    my @l = localtime($at);
    my $prompt = '/loop check the preview deploy';
    append_file(session_file(), qq({"type":"assistant","timestamp":") . stamp() . qq(","message":{"role":"assistant","content":[{"type":"tool_use","id":"tw-$id","name":"ScheduleWakeup","input":{"delaySeconds":$delay,"reason":"The preview build takes a few minutes; nothing pushes its status to me.","prompt":"$prompt"}}]}}\n));
    append_file(session_file(), qq({"type":"user","timestamp":") . stamp() . qq(","message":{"role":"user","content":[{"tool_use_id":"tw-$id","type":"tool_result","content":"Next wakeup scheduled"}]},"toolUseResult":{"scheduledFor":) . ($at * 1000) . qq(,"clampedDelaySeconds":$delay,"wasClamped":false}}\n));
    $crons = qq([{"id":"$id","schedule":"$l[1] $l[2] * * *","recurring":false,"prompt":"$prompt"}]);
    send_hook(qq({"hook_event_name":"Stop","session_id":"$sid","session_crons":$crons}));
  }
  elsif ($what eq 'loop-stop') {
    append_file(session_file(), qq({"type":"assistant","timestamp":") . stamp() . qq(","message":{"role":"assistant","content":[{"type":"tool_use","id":"tw-stop","name":"ScheduleWakeup","input":{"stop":true}}]}}\n));
    $crons = '[]';
    send_hook(qq({"hook_event_name":"Stop","session_id":"$sid","session_crons":$crons}));
  }
  # "serve:<port>": a dev server started in the background, the way Claude Code runs one: a direct child of claude,
  # `/bin/zsh -c "… && eval '<command>' < /dev/null && …"`, whose own child listens on <port>; then its PostToolUse.
  # The server lives 2 minutes at most, in its own process group, killed when this fake exits. (Its socket is kept in
  # @s: an unreferenced one would close at once.)
  elsif ($what =~ /^serve:(\d+)$/) {
    my $cmd = qq(perl -MIO::Socket::INET -e "\@s = IO::Socket::INET->new(LocalAddr=>q{127.0.0.1},LocalPort=>$1,Listen=>5,ReuseAddr=>1) or die; sleep 120");
    (my $quoted = $cmd) =~ s/'/'\\''/g;
    my $pid = fork();
    die "fork: $!" unless defined $pid;
    if ($pid == 0) { no warnings 'exec'; setpgrp(0, 0); exec('/bin/zsh', '-c', "source /dev/null && eval '$quoted' < /dev/null && pwd -P >| /dev/null"); POSIX::_exit(1); }
    push @servers, $pid;
    print "FAKE-CLAUDE serve-pid=$pid\n";
    bg_add("srv$1", $cmd, "Dev server on $1", undef);
  }
  # Background inspector: "bg-cwd" reports the cwd (Claude Code's folders are keyed by
  # it); "bg-out:<id>:<text>" appends a line to that task's output file and "bg-exit:<id>:<code>" its trailer;
  # "bg-agent:<id>" starts a subagent with a transcript (its task and one Read), "bg-agent-step:<id>:<text>" appends a
  # Grep for <text>, "bg-agent-bash:<agent>:<id>:<cmd>" the subagent's background Bash <id> (transcript and hook).
  elsif ($what eq 'bg-cwd') { send_hook(qq({"hook_event_name":"Notification","session_id":"$sid","notification_type":"fake_cwd","message":"m","cwd":") . js(Cwd::getcwd()) . '"}'); }
  elsif ($what =~ /^bg-out:(\w+):(.*)$/) { append_file(task_file($1), "$2\n"); }
  elsif ($what =~ /^bg-exit:(\w+):(\d+)$/) { append_file(task_file($1), "\n[exited with code $2]\n"); }
  elsif ($what =~ /^bg-agent:(\w+)$/) {
    send_hook(qq({"hook_event_name":"SubagentStart","session_id":"$sid","agent_id":"$1","agent_type":"Explore"}));
    append_file(agent_file($1), qq({"type":"user","timestamp":") . stamp() . qq(","message":{"role":"user","content":"Map the refresh flow"}}\n));
    append_file(agent_file($1), qq({"type":"assistant","timestamp":") . stamp() . qq(","message":{"role":"assistant","model":"claude-haiku-5-5","content":[{"type":"tool_use","id":"t1","name":"Read","input":{"file_path":"src/auth/session.ts"}}]}}\n));
  }
  # "bg-agent-long:<id>": like bg-agent, but its task is a long multi-line prompt ending with "LAST LINE: done".
  elsif ($what =~ /^bg-agent-long:(\w+)$/) {
    send_hook(qq({"hook_event_name":"SubagentStart","session_id":"$sid","agent_id":"$1","agent_type":"Explore"}));
    my $task = join('\n', (map { "$_. Check the refresh path in module $_ and report every caller you find, with file and line" } 1..14), 'LAST LINE: done');
    append_file(agent_file($1), qq({"type":"user","timestamp":") . stamp() . qq(","message":{"role":"user","content":"$task"}}\n));
  }
  elsif ($what =~ /^bg-agent-step:(\w+):(.+)$/) {
    append_file(agent_file($1), qq({"type":"assistant","timestamp":") . stamp() . qq(","message":{"role":"assistant","content":[{"type":"tool_use","id":"t2","name":"Grep","input":{"pattern":") . js($2) . qq("}}]}}\n));
  }
  elsif ($what =~ /^bg-agent-bash:(\w+):(\w+):(.+)$/) {
    my ($agent, $id, $cmd) = ($1, $2, $3);
    append_file(agent_file($agent), qq({"type":"assistant","timestamp":") . stamp() . qq(","message":{"role":"assistant","content":[{"type":"tool_use","id":"t-$id","name":"Bash","input":{"command":") . js($cmd) . qq(","run_in_background":true}}]}}\n));
    append_file(agent_file($agent), qq({"type":"user","timestamp":") . stamp() . qq(","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t-$id","content":"Command running in background with ID: $id"}]},"toolUseResult":{"stdout":"","stderr":"","interrupted":false,"backgroundTaskId":"$id"}}\n));
    bg_add($id, $cmd, undef, $agent);
  }
  # "listen-ephemeral": this process listens on a random ephemeral port (49152–65535), as a test run's would.
  elsif ($what eq 'listen-ephemeral') {
    require IO::Socket::INET;
    for (1..50) {
      my $s = IO::Socket::INET->new(LocalAddr => '127.0.0.1', LocalPort => 49152 + int(rand(16384)), Listen => 5, ReuseAddr => 0, Proto => 'tcp');
      if ($s) { push @listeners, $s; last; }
    }
  }
  # "listen:<n>": this process listens on n random non-ephemeral ports (a dev server's), shown as port chips.
  elsif ($what =~ /^listen:(\d+)$/) {
    require IO::Socket::INET;
    for (1..$1) {
      for (1..50) {
        my $s = IO::Socket::INET->new(LocalAddr => '127.0.0.1', LocalPort => 20000 + int(rand(25000)), Listen => 5, ReuseAddr => 0, Proto => 'tcp');
        if ($s) { push @listeners, $s; last; }
      }
    }
  }
}
$SIG{ALRM} = sub { exit 0 }; alarm 30;
while (my $next = <STDIN>) {
  chomp $next; $next =~ s/\r$//; print "FAKE-CLAUDE got=$next\n";
  # "/exit": Claude Code quits: its SessionEnd, then the process ends and the shell is back.
  if ($next eq '/exit') { send_hook(qq({"hook_event_name":"SessionEnd","session_id":"$sid","reason":"prompt_input_exit"})); print "FAKE-CLAUDE bye\n"; exit 0; }
  ev($1) if $next =~ /^ev:(.+)$/;
  alarm 30;
}
sleep 30;
