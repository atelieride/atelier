#!/usr/bin/perl
# Fake claude whose prompt is free as soon as it starts (tasks → sessions). After
# ATELIER_FAKE_START_DELAY seconds (if set) it sends SessionStart, then Stop (state done), then behaves like Claude's
# prompt: raw mode with bracketed paste on; a pasted block is echoed (newlines shown as ⏎) and stays in the prompt; only
# an Enter outside a paste submits it, printed as "FAKE-CLAUDE submitted=<text>" — unless it comes within 100 ms of the
# paste's end, which is lost ("FAKE-CLAUDE lost-enter"), as Claude Code can lose one behind a long paste. Before the
# prompt is ready, bracketed paste is off: anything typed then would be echoed as "FAKE-CLAUDE early=<bytes>".
use strict; use warnings;
use POSIX qw(:termios_h);
use Time::HiRes ();
$| = 1;
my $hook = "$ENV{ATELIER_HOME}/bin/atelier-hook";
my $sid = "prompt-$$";
sub send_hook { open(my $h, '|-', $hook) or die; print $h $_[0]; close $h; }
my $title = ''; for my $i (0..$#ARGV) { $title = $ARGV[$i+1] if $ARGV[$i] eq '-n'; $title = $1 if $ARGV[$i] =~ /^--name=(.*)$/s; }
$title =~ s/(["\\])/\\$1/g;

my $t = POSIX::Termios->new; $t->getattr(0);
$t->setlflag($t->getlflag & ~(ECHO | ICANON)); $t->setiflag($t->getiflag & ~(ICRNL | INLCR)); $t->setcc(VMIN, 0); $t->setcc(VTIME, 0);
$t->setattr(0, TCSANOW);
print "FAKE-CLAUDE starting\n";
# Started with another Claude account: the config dir it was given, for the test to read.
print "FAKE-CLAUDE config=$ENV{CLAUDE_CONFIG_DIR}\n" if $ENV{CLAUDE_CONFIG_DIR};
# Starting: whatever arrives now was typed too early.
my $until = time() + ($ENV{ATELIER_FAKE_START_DELAY} // 0);
while (time() < $until) {
  my $got = '';
  if (sysread(STDIN, $got, 4096)) { (my $shown = $got) =~ s/[\x00-\x1f]/./g; print "FAKE-CLAUDE early=$shown\n"; }
  select(undef, undef, undef, 0.05);
}
send_hook(qq({"hook_event_name":"SessionStart","session_id":"$sid","source":"startup","session_title":"$title"}));
send_hook(qq({"hook_event_name":"Stop","session_id":"$sid"}));

# Claude's prompt: raw keys, bracketed paste on.
$t->setcc(VMIN, 1); $t->setattr(0, TCSANOW);
print "\e[?2004h> ";
$SIG{ALRM} = sub { exit 0 }; alarm 120;
my ($buf, $pending, $pasting, $pasteEnd) = ('', '', 0, 0);
while (sysread(STDIN, my $c, 1)) {
  $pending .= $c;
  if ($pending =~ /^\e/) {
    # An escape sequence: wait for the whole marker.
    if ($pending eq "\e[200~") { $pasting = 1; $pending = ''; }
    elsif ($pending eq "\e[201~") { $pasting = 0; $pending = ''; $pasteEnd = Time::HiRes::time(); }
    elsif (length($pending) >= 6 || "\e[200~" !~ /^\Q$pending\E/ && "\e[201~" !~ /^\Q$pending\E/) { $pending = ''; }
    next;
  }
  $pending = '';
  if ($c eq "\r" || $c eq "\n") {
    # A newline inside the paste: shown as ⏎ (its UTF-8 bytes; input stays bytes too).
    if ($pasting) { $buf .= "\xe2\x8f\x8e"; print "\xe2\x8f\x8e"; next; }
    # Like Claude Code with a long paste still being handled: an Enter right behind the paste is lost.
    if (Time::HiRes::time() - $pasteEnd < 0.1) { print "\nFAKE-CLAUDE lost-enter\n> "; next; }
    print "\nFAKE-CLAUDE submitted=$buf\n> ";
    $buf = '';
    next;
  }
  $buf .= $c; print $c;
}
