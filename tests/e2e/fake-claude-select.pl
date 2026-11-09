#!/usr/bin/perl
# Fake full-screen claude for Send Selection: a session waiting for input that draws
# an answer with a code block on the alternate screen and captures the mouse (SGR reports, like Claude Code). A press
# then a release highlight the rows between them, as Claude's own selection does; copying it to the clipboard is the
# test's part (the test clipboard log). Bytes typed outside mouse reports are shown on the prompt row.
use strict; use warnings;
use POSIX qw(:termios_h);
$| = 1;
my $home = $ENV{ATELIER_HOME};
my $hook = "$home/bin/atelier-hook";
my $status = "$home/bin/atelier-statusline";
my $sid = "select-$$";
sub pipe_to { my ($cmd, $s) = @_; open(my $h, '|-', $cmd) or die; print $h $s; close $h; }
my $title = ''; for my $i (0..$#ARGV) { $title = $ARGV[$i+1] if $ARGV[$i] eq '-n'; }
$title =~ s/(["\\])/\\$1/g;

my $t = POSIX::Termios->new; $t->getattr(0);
$t->setlflag($t->getlflag & ~(ECHO | ICANON | ISIG)); $t->setiflag($t->getiflag & ~(ICRNL | INLCR | IXON)); $t->setcc(VMIN, 1); $t->setcc(VTIME, 0);
$t->setattr(0, TCSANOW);

pipe_to($hook, qq({"hook_event_name":"SessionStart","session_id":"$sid","source":"startup","session_title":"$title","permission_mode":"default"}));
pipe_to("$status >/dev/null", qq({"session_id":"$sid","model":{"id":"claude-opus-5-5","display_name":"Opus 5.5"},"cost":{"total_cost_usd":0.84,"total_lines_added":0,"total_lines_removed":0},"context_window":{"used_percentage":12}}));
pipe_to($hook, qq({"hook_event_name":"Stop","session_id":"$sid","permission_mode":"default"}));

my @lines = (
  '',
  ' > Where do the build files go, and how do I check it worked?',
  '',
  " \e[38;5;141m⏺\e[0m They go to \e[1mbuild/\e[0m at the project root. Make the folder, step into it and",
  '   print where you are:',
  '',
  '     mkdir -p build && cd build',
  '     echo "ready: $(basename "$PWD")"',
  '',
  "   If it prints \e[1mready: build\e[0m you are in the right place.",
  ''
);
my ($from, $to) = (0, -1);
my $typed = '';
sub draw {
  print "\e[H\e[2J";
  for my $i (0..$#lines) {
    my $row = $i + 1;
    my $text = $lines[$i];
    if ($row >= $from && $row <= $to) { (my $plain = $text) =~ s/\e\[[0-9;]*m//g; print "\e[${row};1H\e[48;5;60m$plain\e[0m"; }
    else { print "\e[${row};1H$text"; }
  }
  my $p = @lines + 2;
  print "\e[${p};1H\e[38;5;245m" . ('─' x 70) . "\e[0m\e[" . ($p + 1) . ";1H > $typed";
}
# Alternate screen, mouse captured with SGR reports, bracketed paste on (as Claude Code).
print "\e[?1049h\e[?1000h\e[?1006h\e[?2004h";
draw();

$SIG{ALRM} = sub { exit 0 }; alarm 180;
my $buf = '';
while (sysread(STDIN, my $c, 64)) {
  $buf .= $c;
  while ($buf =~ s/\e\[<(\d+);(\d+);(\d+)([Mm])//) {
    my ($b, $y, $kind) = ($1, $3, $4);
    next unless ($b & 3) == 0;
    if ($kind eq 'M') { ($from, $to) = ($y, -1); }
    else { ($from, $to) = $y >= $from ? ($from, $y) : ($y, $from); }
    draw();
  }
  next if $buf =~ /\e\[<[\d;]*$/;
  $buf =~ s/\e\[20[01]~//g;
  $typed .= $buf =~ s/[\r\n]+/ ⏎ /gr;
  $buf = '';
  draw();
}
