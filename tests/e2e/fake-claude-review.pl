#!/usr/bin/perl
# Fake claude for the review loop. It "edits" $ATELIER_FAKE_EDIT, then waits on a permission dialog
# (state waiting) until a first Enter, then finishes (state done). From then on it behaves like Claude's prompt:
# raw mode with bracketed paste on; a pasted block is echoed (newlines shown as ⏎) and stays in the prompt; only an
# Enter outside a paste submits it, printed as "FAKE-CLAUDE submitted=<text>".
use strict; use warnings;
use POSIX qw(:termios_h);
$| = 1;
my $hook = "$ENV{ATELIER_HOME}/bin/atelier-hook";
my $sid = "review-$$";
sub send_hook { open(my $h, '|-', $hook) or die; print $h $_[0]; close $h; }
my $title = ''; for my $i (0..$#ARGV) { $title = $ARGV[$i+1] if $ARGV[$i] eq '-n'; $title = $1 if $ARGV[$i] =~ /^--name=(.*)$/s; }
$title =~ s/(["\\])/\\$1/g;
my $file = $ENV{ATELIER_FAKE_EDIT} // '';
send_hook(qq({"hook_event_name":"SessionStart","session_id":"$sid","source":"startup","session_title":"$title"}));
send_hook(qq({"hook_event_name":"UserPromptSubmit","session_id":"$sid","prompt":"x"}));
send_hook(qq({"hook_event_name":"PostToolUse","session_id":"$sid","tool_name":"Edit","tool_input":{"file_path":"$file","old_string":"a","new_string":"b"}}));
send_hook(qq({"hook_event_name":"PermissionRequest","session_id":"$sid","tool_name":"Bash","tool_input":{"command":"npm test"}}));
print "FAKE-CLAUDE waiting; press enter\n";
my $first = <STDIN>;
send_hook(qq({"hook_event_name":"Stop","session_id":"$sid"}));
print "FAKE-CLAUDE done\n";

# Claude's prompt: raw keys, bracketed paste on.
my $t = POSIX::Termios->new; $t->getattr(0);
$t->setlflag($t->getlflag & ~(ECHO | ICANON)); $t->setiflag($t->getiflag & ~(ICRNL | INLCR)); $t->setcc(VMIN, 1); $t->setcc(VTIME, 0);
$t->setattr(0, TCSANOW);
print "\e[?2004h> ";
$SIG{ALRM} = sub { exit 0 }; alarm 90;
my ($buf, $pending, $pasting) = ('', '', 0);
while (sysread(STDIN, my $c, 1)) {
  $pending .= $c;
  if ($pending =~ /^\e/) {
    # An escape sequence: wait for the whole marker.
    if ($pending eq "\e[200~") { $pasting = 1; $pending = ''; }
    elsif ($pending eq "\e[201~") { $pasting = 0; $pending = ''; }
    elsif (length($pending) >= 6 || "\e[200~" !~ /^\Q$pending\E/ && "\e[201~" !~ /^\Q$pending\E/) { $pending = ''; }
    next;
  }
  $pending = '';
  if ($c eq "\r" || $c eq "\n") {
    # A newline inside the paste: shown as ⏎ (its UTF-8 bytes; input stays bytes too).
    if ($pasting) { $buf .= "\xe2\x8f\x8e"; print "\xe2\x8f\x8e"; next; }
    print "\nFAKE-CLAUDE submitted=$buf\n> ";
    $buf = '';
    next;
  }
  $buf .= $c; print $c;
}
