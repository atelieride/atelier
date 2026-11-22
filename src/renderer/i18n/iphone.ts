// Settings › iPhone's and the pairing sheet's strings, loaded with their lazy chunks rather than with en.ts: the live
// demo's first paint has no room for them. en.ts keeps what the first paint shows (`t.iphone`: the footer pill, the
// phone badge, the size note, the command). Same rules as en.ts: written for macOS, in Windows' words there.
import { currentPlatform } from '@shared/platform';
import { localize } from '@shared/windows-words';

const strings = {
  access: 'Allow access from iPhone',
  accessHint: 'This computer connects to the relay only while this is on. Everything between your iPhone and this computer is end-to-end encrypted.',
  relay: {
    online: 'Connected to the relay', connecting: 'Connecting to the relay…', offline: "Can't reach the relay. Atelier keeps trying.",
    failed: "Atelier can't use the relay.", unavailable: "This computer can't keep the keys for iPhone access encrypted, so iPhone access is unavailable."
  },
  statusLabel: 'iPhone access status',
  pair: 'Pair iPhone…', pairLabel: 'Pair an iPhone', pairHint: 'Shows a code to scan or type in Atelier on your iPhone.',
  devices: 'Paired iPhones',
  devicesNone: 'No iPhone paired yet', devicesNoneHint: 'Pair one to follow your sessions and type in them from anywhere.',
  connected: 'Connected', lastSeen: (ago: string) => `Last seen ${ago}`,
  openCount: (n: number) => (n === 1 ? '1 terminal open' : `${n} terminals open`),
  remove: 'Remove', removeTip: (name: string) => `Remove ${name}`,
  removeAsk: (name: string) => `Remove ${name}?`, removeBody: 'It disconnects now and has to pair again to come back.',
  advanced: 'Advanced', relayServer: 'Relay server',
  relayServerHint: 'Passes the encrypted traffic between your iPhone and this computer, without being able to read it. Change it only to use a relay of your own.',
  relayBad: {
    empty: 'Type the address of a relay, or use the default one.', scheme: 'Use an address that starts with https://.',
    http: 'http:// works only for this computer or your local network. Use https:// for any other relay.',
    parts: 'Leave out user names, passwords, queries and fragments.', invalid: 'This is not an address Atelier can use.'
  },
  relayDefault: 'Use Default',
  forget: 'Forget all iPhones', forgetHint: 'Unpairs every iPhone and gives this computer a new identity.', forgetButton: 'Forget All…',
  forgetAsk: 'Forget all iPhones?', forgetBody: 'Every iPhone disconnects and has to pair again.', forgetConfirm: 'Forget All',
  // The pairing sheet.
  sheetTitle: 'Pair iPhone', close: 'Close',
  step1: 'Open Atelier on your iPhone', step2: 'Scan the code, or type it',
  codeLabel: 'Pairing code', qrLabel: 'QR code that pairs an iPhone with this computer',
  renewsIn: (left: string) => `New code in ${left}`, renewing: 'New code coming…',
  notOnline: 'Atelier isn\'t connected to the relay yet: the code works once it is.',
  declined: 'Denied. That code is spent: here is a fresh one.', expired: 'No answer in time. That code is spent: here is a fresh one.',
  offTitle: 'iPhone access is off', offBody: 'Turn it on to pair. This computer connects to the relay only while it is on, and everything between your iPhone and this computer is end-to-end encrypted.',
  turnOn: 'Turn On and Pair', unavailableTitle: 'iPhone access is unavailable', errorTitle: "Atelier couldn't show a code", tryAgain: 'Try Again',
  askTitle: (name: string) => `Allow ${name} to use Atelier?`,
  askBody: 'It will be able to see your sessions and type in them.',
  allow: 'Allow', deny: 'Deny', answerWithin: (left: string) => `Answer within ${left}`, allowing: 'Pairing…',
  paired: 'iPhone paired'
} as const;

/** Windows names its own places and tools. macOS: as written. */
export const tiph = currentPlatform() === 'win32' ? localize(strings) : strings;
