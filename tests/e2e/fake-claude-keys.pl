#!/usr/bin/perl
# Fake claude for the Session panel: its prompt is free as soon as it starts (SessionStart, a status line
# with the model, Stop), and every byte typed into it is appended, raw, to $ATELIER_FAKE_KEYS_LOG — so a test sees
# exactly what Atelier typed, Enter and escape sequences included. In raw mode, like Claude's prompt:
# - an Enter submits the line: "work" starts a turn (UserPromptSubmit: the session is working), "stop" ends it (Stop),
#   "/model <name>" reports the new model on the status line; each is printed as "FAKE-CLAUDE submitted=<line>";
# - Shift+Tab (ESC [ Z) moves to the next permission mode, reported on a hook event as Claude Code does;
# - Ctrl+C during a turn draws "⎿ Interrupted · What should Claude do instead?", with no hook (as Claude Code);
# - a lone Esc during a turn (it never writes anything) puts the prompt back into the input box, with no hook either:
#   Claude Code's take-back of a turn interrupted before it wrote anything.
use strict; use warnings;
use POSIX qw(:termios_h);
$| = 1;
my $home = $ENV{ATELIER_HOME};
my $hook = "$home/bin/atelier-hook";
my $status = "$home/bin/atelier-statusline";
my $log = $ENV{ATELIER_FAKE_KEYS_LOG} // "$home/fake-keys.log";
# ATELIER_FAKE_SESSION_ID: a real-looking session id (a uuid), for a test that writes this session's transcript (Ask).
my $sid = $ENV{ATELIER_FAKE_SESSION_ID} // "keys-$$";
sub pipe_to { my ($cmd, $s) = @_; open(my $h, '|-', $cmd) or die; print $h $s; close $h; }
sub send_hook { pipe_to($hook, $_[0]); }
sub model { pipe_to("$status >/dev/null", qq({"session_id":"$sid","model":{"id":"claude-$_[0]","display_name":"$_[0]"},"cost":{"total_cost_usd":1.5,"total_lines_added":12,"total_lines_removed":3},"context_window":{"used_percentage":31}})); }
my $title = ''; for my $i (0..$#ARGV) { $title = $ARGV[$i+1] if $ARGV[$i] eq '-n'; $title = $1 if $ARGV[$i] =~ /^--name=(.*)$/s; }
$title =~ s/(["\\])/\\$1/g;
my @modes = ('default', 'acceptEdits', 'plan');
my $mode = 0;

my $t = POSIX::Termios->new; $t->getattr(0);
$t->setlflag($t->getlflag & ~(ECHO | ICANON | ISIG)); $t->setiflag($t->getiflag & ~(ICRNL | INLCR | IXON)); $t->setcc(VMIN, 1); $t->setcc(VTIME, 0);
$t->setattr(0, TCSANOW);

send_hook(qq({"hook_event_name":"SessionStart","session_id":"$sid","source":"startup","session_title":"$title","permission_mode":"default"}));
model('Opus 5.5');
send_hook(qq({"hook_event_name":"Stop","session_id":"$sid","permission_mode":"default"}));
print "FAKE-CLAUDE ready\n> ";
# ATELIER_FAKE_BRACKETED=1: bracketed paste on, as Claude Code's prompt (scheduled prompts are typed only into one).
print "\e[?2004h" if $ENV{ATELIER_FAKE_BRACKETED};

$SIG{ALRM} = sub { exit 0 }; alarm 180;
open(my $out, '>>', $log) or die "log: $!";
binmode $out; my $old = select($out); $| = 1; select($old);
my ($buf, $pending, $last) = ('', '', '');
my $working = 0;
# More input right behind this byte: an Esc key arrives alone, a sequence (arrows, Shift+Tab, a paste) in one write.
sub more_input { my $rin = ''; vec($rin, fileno(STDIN), 1) = 1; return select(my $rout = $rin, undef, undef, 0.05) > 0; }
while (sysread(STDIN, my $c, 1)) {
  print $out $c;
  alarm 180;
  $pending .= $c;
  if ($pending eq "\e" && !more_input()) {
    $pending = '';
    if ($working) { $working = 0; $buf = $last; print "\r\n> $buf"; }
    next;
  }
  if ($pending =~ /^\e/) {
    if ($pending eq "\e[Z") {
      $mode = ($mode + 1) % @modes;
      print "\nFAKE-CLAUDE mode=$modes[$mode]\n> ";
      send_hook(qq({"hook_event_name":"Notification","session_id":"$sid","notification_type":"fake_mode","message":"m","permission_mode":"$modes[$mode]"}));
      $pending = '';
    } elsif (length($pending) >= 3 || "\e[Z" !~ /^\Q$pending\E/) { $pending = ''; }
    next;
  }
  $pending = '';
  # Ctrl+C during a turn: Claude Code draws its interruption notice and sends no hook at all.
  if ($c eq "\x03") {
    print "\n\e[2K\e[38;5;246m  \x{e2}\x{8e}\x{bf}  \e[39m\e[31mInterrupted\e[39m\e[1C\x{c2}\x{b7} What should Claude do instead?\n> " if $working;
    $working = 0;
    next;
  }
  if ($c eq "\r") {
    print "\nFAKE-CLAUDE submitted=$buf\n";
    $last = $buf;
    if ($buf eq 'work') { $working = 1; send_hook(qq({"hook_event_name":"UserPromptSubmit","session_id":"$sid","prompt":"work"})); }
    elsif ($buf eq 'stop') { $working = 0; send_hook(qq({"hook_event_name":"Stop","session_id":"$sid"})); }
    elsif ($buf =~ m{^/model (\w+)$}) { model(ucfirst $1); }
    print "> ";
    $buf = '';
    next;
  }
  $buf .= $c; print $c;
}
