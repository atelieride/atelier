#!/usr/bin/perl
# Demo Claude for the website's screenshots (tests/e2e/site-shots.manual.ts). Plays the scenario named after the
# session (-n <name>) from ATELIER_DEMO_SCENARIOS (src/demo/world/scenarios.ts, written as JSON): file edits inside the
# demo project and the hook events that put the session in its state, then draws a full-screen view like Claude Code's (transcript on top; prompt, permission request,
# question or spinner at the bottom), redrawn when the pane is resized. Same bridges as tests/e2e/fake-claude.pl.
# A scenario's optional `background` plays its background work too (see play_background below).
use strict; use warnings; use utf8;
use JSON::PP (); use Cwd (); use IPC::Open2 (); use File::Path (); use POSIX ();
binmode(STDOUT, ':utf8');
$| = 1;
my $home = $ENV{ATELIER_HOME};
my $hook = "$home/bin/atelier-hook";
my $status = "$home/bin/atelier-statusline";
my $name = '';
for my $i (0..$#ARGV) { $name = $ARGV[$i+1] if $ARGV[$i] eq '-n' && defined $ARGV[$i+1]; $name = $1 if $ARGV[$i] =~ /^--name=(.*)$/s; }
# A UUID, like Claude Code's: the Background inspector computes no path for any other session id.
my $sid = sprintf('%08x-%04x-4%03x-a%03x-%012x', time() & 0xffffffff, $$ & 0xffff, int(rand(0x1000)), int(rand(0x1000)), int(rand(2**32)) * 0x10000 + int(rand(0x10000)));
my $all = do { local $/; open(my $f, '<', $ENV{ATELIER_DEMO_SCENARIOS}) or die "scenarios: $!"; JSON::PP->new->utf8->decode(<$f>) };
my $sc = $all->{$name} or die "no demo scenario for '$name'\n";
my $json = JSON::PP->new->utf8->canonical;
# The bridges' replies are read and dropped: nothing but the drawing reaches the terminal.
sub bridge { my ($bin, $data) = @_; my $pid = IPC::Open2::open2(my $out, my $in, $bin); print $in $json->encode($data); close $in; local $/; my $r = <$out>; close $out; waitpid($pid, 0); }
sub hook { my ($ev) = @_; bridge($hook, { %$ev, session_id => $sid }); }
sub status { bridge($status, { session_id => $sid, session_name => $name, %{$_[0]} }); }

my ($ESC, $DIM, $RST, $BOLD) = ("\e", "\e[2m", "\e[0m", "\e[1m");
my $state = $sc->{state};
# The bottom area, as Claude Code shows it for each state.
my @bottom = $state eq 'permission' ? (" ${BOLD}Bash command$RST", "   $sc->{command}", '', ' Do you want to proceed?', " \e[36m❯ 1. Yes$RST", '   2. Yes, and don\'t ask again', '   3. No, tell Claude what to do')
  : $state eq 'question' ? (map { $_ == 0 ? " \e[36m❯ 1. $sc->{options}[0]$RST" : '   ' . ($_ + 1) . ". $sc->{options}[$_]" } 0..$#{$sc->{options}})
  : $state eq 'working' ? ("\e[38;5;211m✻ $sc->{spinner}$RST ${DIM}(esc to interrupt)$RST", '', '> ', '')
  : ('', '> ', '');

sub size { my $s = `stty size 2>/dev/null </dev/tty` // ''; my ($r, $c) = split ' ', $s; return (($r || 36), ($c || 99)); }
sub draw {
  my ($rows, $cols) = size();
  print "\e[2J\e[H";
  print "$_\r\n" for @{$sc->{transcript}};
  my $top = $rows - @bottom;
  print "\e[${top};1H$DIM" . ('─' x $cols) . $RST;
  for my $i (0..$#bottom) { print "\e[" . ($top + 1 + $i) . ";1H$bottom[$i]"; }
  # The cursor sits in the prompt; a permission request or a question hides it, as Claude Code does.
  my ($prompt) = grep { $bottom[$_] eq '> ' } 0..$#bottom;
  print defined $prompt ? "\e[?25h\e[" . ($top + 1 + $prompt) . ';3H' : "\e[?25l";
}

my $cwd = Cwd::getcwd();
# The transcript's path under the config dir Claude runs with (CLAUDE_CONFIG_DIR, set by a session started as another
# Claude account, else the default one under ATELIER_TEST_CLAUDE_HOME), as Claude Code sends it: atelierd learns the
# session's account from it. Nothing is written there.
my $cfg = $ENV{CLAUDE_CONFIG_DIR} || ($ENV{ATELIER_TEST_CLAUDE_HOME} ? "$ENV{ATELIER_TEST_CLAUDE_HOME}/.claude" : '');
(my $encoded = $cwd) =~ s/[^A-Za-z0-9]/-/g;
my %transcript = $cfg ? (transcript_path => "$cfg/projects/$encoded/$sid.jsonl") : ();
# The cwd, as Claude Code reports it: the session's folders (task outputs, subagent transcripts) are keyed by it.
hook({ hook_event_name => 'SessionStart', source => 'startup', session_title => $name, cwd => $cwd, %transcript });
hook({ hook_event_name => 'UserPromptSubmit', prompt => $sc->{prompt}, session_title => $name });
for my $e (@{$sc->{edits} || []}) {
  my $path = "$cwd/$e->{file}";
  hook({ hook_event_name => 'PreToolUse', tool_name => 'Edit', tool_input => { file_path => $path } });
  open(my $f, '>:utf8', $path) or die "edit $path: $!"; print $f $e->{content}; close $f;
  hook({ hook_event_name => 'PostToolUse', tool_name => 'Edit', tool_input => { file_path => $path } });
}
my $r5 = time() + 2 * 3600; my $r7 = time() + 3 * 86400;
# The limits of the scenario's account (site-shots.manual.ts adds them from src/demo/world/accounts.ts).
my ($l5, $l7) = @{$sc->{limits} || [34, 12]};
status({ %transcript, model => { id => 'claude-opus-5-5', display_name => 'Opus 5.5' },
  cost => { total_cost_usd => $sc->{cost}, total_lines_added => $sc->{added}, total_lines_removed => $sc->{removed} },
  context_window => { used_percentage => $sc->{context} },
  rate_limits => { five_hour => { used_percentage => $l5, resets_at => $r5 }, seven_day => { used_percentage => $l7, resets_at => $r7 } } });

# Background work, played before the state's own events, as Claude Code reports and
# writes it:
# - `crons`: a Stop carrying them (session_crons), then the next turn starts with the same prompt;
# - `agents` ({ id, description, type?, task, steps }): SubagentStart, the Agent tool's PostToolUse (its description and
#   agentId) and a transcript: the task, then per step an assistant `tool_use` ({ tool, input, result: text or a line
#   count, error? }) with its `tool_result`, or a `text`; timestamps a few seconds apart, ending now;
# - `shells` ({ id, description, command, output: [lines], exit? }): a background Bash's PostToolUse with its
#   backgroundTaskId, and its output file (with the exit trailer when `exit` is set).
# The files go where Claude Code keeps them, under the test roots e2eEnv sets (ATELIER_TEST_CLAUDE_TMP and
# ATELIER_TEST_CLAUDE_PROJECTS), keyed by the encoded cwd and the session id. Relative file_path/path inputs are made
# absolute in the project (the inspector shows them relative again).
my %started;
my $raw = JSON::PP->new->canonical;   # character strings: the file is opened with :utf8
sub bg_dir {
  my ($var, @rest) = @_;
  my $root = $ENV{$var} or die "$var is not set\n";
  (my $enc = $cwd) =~ s/[^A-Za-z0-9]/-/g;
  my $d = join('/', $root, $enc, $sid, @rest);
  File::Path::make_path($d);
  return $d;
}
sub write_lines { my ($path, @lines) = @_; open(my $f, '>:utf8', $path) or die "$path: $!"; print $f $_ for @lines; close $f; }
sub stamp { return POSIX::strftime('%Y-%m-%dT%H:%M:%S.000Z', gmtime($_[0])); }
sub in_project { my ($input) = @_; my %i = %$input; for my $k (qw(file_path path)) { $i{$k} = "$cwd/$i{$k}" if defined $i{$k} && $i{$k} !~ m{^/}; } return \%i; }
sub play_background {
  my ($bg) = @_;
  if (@{$bg->{crons} || []}) {
    hook({ hook_event_name => 'Stop', session_crons => $bg->{crons} });
    hook({ hook_event_name => 'UserPromptSubmit', prompt => $sc->{prompt}, session_title => $name });
  }
  for my $a (@{$bg->{agents} || []}) {
    my $type = $a->{type} || 'Explore';
    hook({ hook_event_name => 'SubagentStart', agent_id => $a->{id}, agent_type => $type });
    $started{$a->{id}} = 1;
    hook({ hook_event_name => 'PostToolUse', tool_name => 'Agent', tool_input => { description => $a->{description}, prompt => $a->{task}, subagent_type => $type, run_in_background => JSON::PP::true },
      tool_response => { status => 'async_launched', agentId => $a->{id} } });
    my @steps = @{$a->{steps} || []};
    my $t = time() - 3 * @steps - 2;
    my @lines = ($raw->encode({ type => 'user', timestamp => stamp($t), message => { role => 'user', content => $a->{task} } }) . "\n");
    my $n = 0;
    for my $s (@steps) {
      $t += 3; $n++;
      my $usage = { input_tokens => 1800 + 150 * $n, output_tokens => 120, cache_creation_input_tokens => 0 };
      my $msg = { role => 'assistant', model => 'claude-haiku-5-5', id => "msg_$a->{id}_$n", usage => $usage };
      if (defined $s->{text}) {
        push @lines, $raw->encode({ type => 'assistant', timestamp => stamp($t), message => { %$msg, content => [{ type => 'text', text => $s->{text} }] } }) . "\n";
        next;
      }
      my $use = "toolu_$a->{id}_$n";
      push @lines, $raw->encode({ type => 'assistant', timestamp => stamp($t), message => { %$msg, content => [{ type => 'tool_use', id => $use, name => $s->{tool}, input => in_project($s->{input}) }] } }) . "\n";
      my $result = $s->{result} // '';
      $result = join("\n", map { "line $_" } 1..$result) if $result =~ /^\d+$/;
      push @lines, $raw->encode({ type => 'user', timestamp => stamp($t + 1), message => { role => 'user', content => [{ type => 'tool_result', tool_use_id => $use, content => $result, ($s->{error} ? (is_error => JSON::PP::true) : ()) }] } }) . "\n";
    }
    write_lines(bg_dir('ATELIER_TEST_CLAUDE_PROJECTS', 'subagents') . "/agent-$a->{id}.jsonl", @lines);
  }
  for my $b (@{$bg->{shells} || []}) {
    write_lines(bg_dir('ATELIER_TEST_CLAUDE_TMP', 'tasks') . "/$b->{id}.output", (map { "$_\n" } @{$b->{output} || []}), (defined $b->{exit} ? ("\n[exited with code $b->{exit}]\n") : ()));
    hook({ hook_event_name => 'PostToolUse', tool_name => 'Bash', tool_input => { command => $b->{command}, description => $b->{description}, run_in_background => JSON::PP::true },
      tool_response => { stdout => '', stderr => '', interrupted => JSON::PP::false, isImage => JSON::PP::false, noOutputExpected => JSON::PP::false, backgroundTaskId => $b->{id} } });
  }
}
play_background($sc->{background}) if $sc->{background};

if ($state eq 'permission') {
  hook({ hook_event_name => 'PreToolUse', tool_name => 'Bash', tool_input => { command => $sc->{command} } });
  hook({ hook_event_name => 'PermissionRequest', tool_name => 'Bash', tool_input => { command => $sc->{command} } });
} elsif ($state eq 'question') {
  hook({ hook_event_name => 'PreToolUse', tool_name => 'AskUserQuestion', tool_input => { questions => [] } });
} elsif ($state eq 'working') {
  # `agents`: how many run (those the background already started are not started again).
  hook({ hook_event_name => 'SubagentStart', agent_id => "a$_", agent_type => 'Explore' }) for grep { !$started{"a$_"} } 1..($sc->{agents} || 0);
  hook({ hook_event_name => 'PreToolUse', tool_name => 'Read', tool_input => { file_path => "$cwd/README.md" } });
} elsif ($state eq 'done') {
  hook({ hook_event_name => 'Stop' });
}
draw();
$SIG{WINCH} = \&draw;
$SIG{HUP} = $SIG{TERM} = sub { exit 0 };
# Forever: a signal cuts a sleep short, and one within a second of the last returns 0 (`1 while sleep` then ended).
sleep 3600 while 1;
