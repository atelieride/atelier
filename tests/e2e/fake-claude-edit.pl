#!/usr/bin/perl
# Fake claude that "edits" files: SessionStart with the name given via -n, PostToolUse Edit on
# $ATELIER_FAKE_EDIT (a relative path is taken from the session's folder), Stop (not with ATELIER_FAKE_NO_STOP: the
# session stays in its turn, its edits live). Stays in the foreground (Perl, not a shell) so the session does not close.
use strict; use warnings; use Cwd qw(getcwd);
my $hook = "$ENV{ATELIER_HOME}/bin/atelier-hook";
# ATELIER_FAKE_SESSION_ID: a real-looking session id (a uuid), for a test that writes this session's transcript.
my $sid = $ENV{ATELIER_FAKE_SESSION_ID} // "edit-$$";
sub send_hook { open(my $h, '|-', $hook) or die; print $h $_[0]; close $h; }
my $title = ''; for my $i (0..$#ARGV) { $title = $ARGV[$i+1] if $ARGV[$i] eq '-n'; $title = $1 if $ARGV[$i] =~ /^--name=(.*)$/s; }
$title =~ s/(["\\])/\\$1/g;
# Several files: separated by ':' (one Edit each, in order).
my @files = defined $ENV{ATELIER_FAKE_EDIT} ? split(/:/, $ENV{ATELIER_FAKE_EDIT}) : (undef);
send_hook(qq({"hook_event_name":"SessionStart","session_id":"$sid","source":"startup","session_title":"$title"}));
send_hook(qq({"hook_event_name":"UserPromptSubmit","session_id":"$sid","prompt":"x"}));
sub send_edits {
  for my $file (@files) {
    $file = getcwd() . "/$file" if defined $file && $file !~ m{^/};
    send_hook(qq({"hook_event_name":"PostToolUse","session_id":"$sid","tool_name":"Edit","tool_input":{"file_path":"$file","old_string":"a","new_string":"b"}}));
  }
}
send_edits();
send_hook(qq({"hook_event_name":"Stop","session_id":"$sid"})) unless $ENV{ATELIER_FAKE_NO_STOP};
# ATELIER_FAKE_EDIT_ON_INPUT: each line typed into the session edits the files again (the session changed them later),
# except "ev:<what>" lines, which send that hook event instead: "ev:question" (AskUserQuestion: it waits for an answer),
# "ev:permission" (a Bash permission request), "ev:answered" (the tool ran: it works again).
if ($ENV{ATELIER_FAKE_EDIT_ON_INPUT}) {
  while (defined(my $line = <STDIN>)) {
    $line =~ s/[\r\n]+$//;
    if ($line eq 'ev:question') { send_hook(qq({"hook_event_name":"PreToolUse","session_id":"$sid","tool_name":"AskUserQuestion","tool_input":{"questions":[{"question":"Keep reading the old cookie for one release?","header":"Cookie","options":[{"label":"Yes"},{"label":"No"}]}]}})); }
    elsif ($line eq 'ev:permission') { send_hook(qq({"hook_event_name":"PermissionRequest","session_id":"$sid","tool_name":"Bash","tool_input":{"command":"npm test"}})); }
    elsif ($line eq 'ev:answered') { send_hook(qq({"hook_event_name":"PostToolUse","session_id":"$sid","tool_name":"AskUserQuestion","tool_input":{}})); }
    else { send_edits(); }
  }
}
sleep 600;
