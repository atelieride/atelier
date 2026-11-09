#!/usr/bin/perl
# Fake claude for automations. It logs the arguments it got, then does what a
# task could make Claude do: merge its branch into the project's own checkout (git -C) and push with --no-verify,
# logging git's answers; the guard must refuse both. Then it ends its turn (the run goes to review) and waits.
use strict; use warnings;
$| = 1;
my $hook = "$ENV{ATELIER_HOME}/bin/atelier-hook";
my $sid = "auto-$$";
sub send_hook { open(my $h, '|-', $hook) or die; print $h $_[0]; close $h; }
sub one_line { my $s = shift; $s =~ s/[\r\n]+/ | /g; return $s; }
my $log = $ENV{ATELIER_TEST_AUTO_LOG} or die "ATELIER_TEST_AUTO_LOG is not set\n";
my $title = ''; for my $a (@ARGV) { $title = $1 if $a =~ /^--name=(.*)$/s; }
$title =~ s/(["\\])/\\$1/g;
open(my $L, '>>', $log) or die;
print $L 'ARGS ', join("\x1f", map { one_line($_) } @ARGV), "\n";
print "FAKE-CLAUDE automation\n";
send_hook(qq({"hook_event_name":"SessionStart","session_id":"$sid","source":"startup","session_title":"$title"}));
send_hook(qq({"hook_event_name":"UserPromptSubmit","session_id":"$sid","prompt":"task"}));
chomp(my $common = `git rev-parse --path-format=absolute --git-common-dir`);
(my $root = $common) =~ s{/\.git/?$}{};
chomp(my $branch = `git rev-parse --abbrev-ref HEAD`);
chomp(my $cwd = `pwd`);
print $L "CWD $cwd\n";
print $L "BRANCH $branch\n";
print $L "RUNBRANCH ", ($ENV{ATELIER_RUN_BRANCH} // ''), "\n";
# Work on its own branch first (allowed): a commit, so the merge below would really move the checkout's branch.
open(my $F, '>', 'automated.txt') or die; print $F "work\n"; close $F;
my $commit = `git add automated.txt && git -c user.name=Fake -c user.email=fake\@example.test commit -q -m 'automated work' 2>&1`;
print $L 'COMMIT ', ($? >> 8), ' ', one_line($commit), "\n";
my $merge = `git -C '$root' merge --no-edit '$branch' 2>&1`;
print $L 'MERGE ', ($? >> 8), ' ', one_line($merge), "\n";
my $push = `git push --no-verify origin HEAD 2>&1`;
print $L 'PUSH ', ($? >> 8), ' ', one_line($push), "\n";
close $L;
sleep 1;
send_hook(qq({"hook_event_name":"Stop","session_id":"$sid"}));
print "FAKE-CLAUDE done\n";
$SIG{ALRM} = sub { exit 0 }; alarm 120;
sleep 120;
