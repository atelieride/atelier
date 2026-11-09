#!/usr/bin/perl
# Fake claude for Bash attribution tests. Sends events through the real bridges, as Claude Code would.
# A session whose name starts with "Edit" edits $ATELIER_FAKE_EDIT (PostToolUse Edit) and stops; any other session
# starts a Bash call (PreToolUse Bash, with a tool_use_id) and stays in it until Enter, then PostToolUse and Stop; a
# session whose name starts with "Read" sits in a read-only Bash call. The test changes files
# meanwhile. Perl, not a shell, so it shows up in the foreground and the session does not close.
use strict; use warnings;
$| = 1;
my $hook = "$ENV{ATELIER_HOME}/bin/atelier-hook";
my $sid = "bash-$$";
sub send_hook { open(my $h, '|-', $hook) or die; print $h $_[0]; close $h; }
my $title = ''; for my $i (0..$#ARGV) { $title = $ARGV[$i+1] if $ARGV[$i] eq '-n'; $title = $1 if $ARGV[$i] =~ /^--name=(.*)$/s; }
my $edit = $title =~ /^Edit/;
my $read = $title =~ /^Read/;
$title =~ s/(["\\])/\\$1/g;
send_hook(qq({"hook_event_name":"SessionStart","session_id":"$sid","source":"startup","session_title":"$title"}));
send_hook(qq({"hook_event_name":"UserPromptSubmit","session_id":"$sid","prompt":"x"}));
if ($edit) {
  my $file = $ENV{ATELIER_FAKE_EDIT};
  send_hook(qq({"hook_event_name":"PostToolUse","session_id":"$sid","tool_name":"Edit","tool_input":{"file_path":"$file","old_string":"a","new_string":"b"}}));
  send_hook(qq({"hook_event_name":"Stop","session_id":"$sid"}));
  print "FAKE-CLAUDE edited\n";
  sleep 600;
  exit 0;
}
my $cmd = $read ? qq({"command":"sed -n 1,5p src/a.ts","description":"Read a.ts"})
                : qq({"command":"sed -i '' s/one/two/ src/*.ts","description":"Rewrite sources"});
my $tid = "toolu_fake_$$";
# Like Claude Code, the hook says which folder the call runs from.
use Cwd qw(getcwd);
(my $cwd = getcwd()) =~ s/(["\\])/\\$1/g;
send_hook(qq({"hook_event_name":"PreToolUse","session_id":"$sid","tool_name":"Bash","tool_use_id":"$tid","tool_input":$cmd,"cwd":"$cwd"}));
print "FAKE-CLAUDE in Bash; press enter\n";
my $line = <STDIN>;
send_hook(qq({"hook_event_name":"PostToolUse","session_id":"$sid","tool_name":"Bash","tool_use_id":"$tid","tool_input":$cmd,"tool_response":{}}));
send_hook(qq({"hook_event_name":"Stop","session_id":"$sid"}));
print "FAKE-CLAUDE done\n";
sleep 600;
