// The Databases view's strings, loaded with the view's lazy chunk rather than with en.ts:
// the live demo's first paint has no room for them. en.ts keeps those it already had (`t.db`: the title,
// the read-only line, the tab labels). Same rules as en.ts: written for macOS, in Windows' words there.
import { currentPlatform } from '@shared/platform';
import { localize } from '@shared/windows-words';

const strings = {
  side: {
    // The sidebar's footer and a table tab's Read-only chip (lazy).
    readOnly: 'Read-only. Every query runs in a read-only transaction.',
    refresh: 'Refresh',
    refreshTip: 'Refresh the catalog',
    add: 'Add Connection…',
    thisProject: 'This project',
    everyProject: 'Every project',
    // The sub line's states.
    connecting: 'connecting…',
    needsPassword: 'needs a password',
    notConnected: 'not connected',
    viaSsh: (host: string) => `via SSH ${host}`,
    // No connection saved (nothing is looked for): `code` in backticks.
    emptyTitle: 'No databases yet',
    emptyHint: 'Add one by hand, or paste a `postgres://` URL anywhere in this panel.',
    emptyAdd: 'Add Connection',
    emptyPaste: 'Paste a Connection URL',
    hideIn: 'Hide this view in ',
    hideWhere: 'Settings › Databases',
    // Needs a password.
    password: 'Password',
    passwordFor: (name: string) => `Password for ${name}`,
    saveInKeychain: 'Save in Keychain',
    connect: 'Connect',
    // Can't connect.
    tryAgain: 'Try Again',
    edit: 'Edit Connection…',
    tlsOff: 'Turn TLS Off',
    useTls: 'Use TLS',
    useRequire: 'Use Require',
    refreshCatalog: 'Refresh',
    // The role can write: one quiet line, its reason in the tooltip.
    writeLine: 'This role can write',
    writeTip: 'Atelier stays read-only: every statement runs in a read-only transaction. A read-only role is safer still.',
    dismiss: 'Dismiss',
    // The database chip's switch.
    switched: (database: string) => `Switched to ${database}`,
    copied: 'Copied',
    sqlState: (code: string) => `SQLSTATE ${code}`
  },
  // A call to main that didn't come back (the UI never waits on it).
  fail: {
    connect: "Couldn't connect",
    disconnect: "Couldn't disconnect",
    refresh: "Couldn't refresh",
    duplicate: "Couldn't duplicate the connection",
    save: "Couldn't save the connection",
    roleSql: "Couldn't get the SQL for a read-only role",
    dismiss: "Couldn't dismiss the note",
    schema: "Couldn't change the schema",
    database: "Couldn't switch the database",
    definition: "Couldn't read the definition"
  },
  catalog: {
    databaseTip: (database: string) => `Database ${database}`,
    schemaTip: (schema: string) => `Schema ${schema}`,
    showAll: (n: number) => `Show all ${n.toLocaleString('en-US')}`,
    filter: 'Filter tables',
    sections: { tables: 'Tables', views: 'Views', matviews: 'Materialized views', enums: 'Enums', functions: 'Functions' },
    reading: 'Reading the catalog…',
    none: 'Nothing in this schema yet.',
    // A database without a table in any schema, and the server's others.
    noTables: (database: string) => `No tables in ${database}.`,
    otherDatabases: 'Other databases on this server',
    switchTo: (database: string) => `Switch to ${database}`,
    noMatch: (q: string) => `Nothing matches “${q}”.`,
    estimate: (n: number) => `About ${n.toLocaleString('en-US')} rows (an estimate)`,
    neverAnalyzed: 'Never analyzed: no estimate yet',
    partitions: (n: number) => `${n} partition${n === 1 ? '' : 's'}`,
    values: (n: number) => `${n} value${n === 1 ? '' : 's'}`
  },
  menu: {
    connect: 'Connect',
    disconnect: 'Disconnect',
    overview: 'Overview',
    refresh: 'Refresh',
    edit: 'Edit Connection…',
    duplicate: 'Duplicate',
    copyUrl: 'Copy URL (No Password)',
    copyPsql: 'Copy psql Command',
    copyRoleSql: 'Copy SQL for a Read-only Role',
    remove: 'Remove Connection…',
    open: 'Open',
    openNew: 'Open in New Tab',
    openSide: 'Open to the Side',
    structure: 'Structure',
    relations: 'Relations',
    copyName: 'Copy Name',
    copySelect: 'Copy SELECT',
    copyValues: 'Copy Values',
    copySignature: 'Copy Signature',
    copyDefinition: 'Copy Definition',
    // No session to send to, Redis's words — the press says why, with a Copy.
    sendSchema: (session: string) => `Send Schema to ${session}`,
    sendSchemaNone: 'Send Schema to Session',
    askTable: 'Ask About This Table in a New Session'
  },
  // Add / Edit Connection and Remove's confirm. `code` in backticks.
  sheet: {
    addTitle: 'Add Connection',
    editTitle: 'Edit Connection',
    close: 'Close',
    back: 'Back',
    cancel: 'Cancel',
    url: 'Connection URL',
    urlPlaceholder: 'postgres://user@host:5432/database',
    urlHint: 'Paste one and the rest fills in. A password in it goes to your Keychain, never to a file.',
    urlBad: 'That isn’t a `postgres://` or `postgresql://` URL.',
    urlSlash: 'Encode `/` in the password as `%2F`.',
    pickEngine: 'or pick an engine',
    later: 'Later',
    laterTip: (engine: string) => `${engine} comes later`,
    speaks: 'Speaks Postgres, works today:',
    speaksList: 'Supabase · Neon · Railway · Timescale · CockroachDB · AlloyDB · Aurora',
    opensReadOnly: 'Every connection opens read-only.',
    continue: 'Continue',
    name: 'Name',
    showIn: 'Show in',
    thisProject: 'This project',
    everyProject: 'Every project',
    environment: 'Environment',
    envs: { local: 'Local', dev: 'Development', staging: 'Staging', prod: 'Production' },
    prodHint: 'Production frames its tabs in the theme’s danger color.',
    host: 'Host',
    hostPlaceholder: 'db.example.com',
    socketChip: 'Unix socket',
    port: 'Port',
    database: 'Database',
    user: 'User',
    password: 'Password',
    keychain: 'Keychain',
    saved: '•••• saved',
    newServer: 'Type the password for the new server',
    tls: 'Encryption (TLS)',
    tlsModes: { off: 'Off', prefer: 'Prefer', require: 'Require', verify: 'Verify' },
    tlsHints: {
      off: 'not encrypted',
      prefer: 'encrypted when the server offers it',
      require: 'encrypted, the certificate not checked',
      verify: 'certificate checked against the system’s trusted roots'
    },
    ssh: 'SSH tunnel',
    sshHint: 'Reach the database through a bastion host, with your SSH agent’s keys',
    sshHost: 'SSH host',
    sshHostPlaceholder: 'bastion.example.com or an alias',
    sshPort: 'SSH port',
    sshPortPlaceholder: '22 · from ~/.ssh/config',
    sshUser: 'SSH user',
    sshUserPlaceholder: 'from ~/.ssh/config',
    readOnlyTitle: 'Read-only, always.',
    readOnly: (sec: number) => `Every query runs inside \`BEGIN READ ONLY … ROLLBACK\` and stops after ${sec} s.`,
    test: 'Test Connection',
    testAgain: 'Test Again',
    save: 'Save and Connect',
    notSaved: 'Not saved',
    connectedIn: (ms: number) => `Connected in ${ms.toLocaleString('en-US')} ms`,
    server: (version: string, tls: boolean, role: string) => `PostgreSQL ${version} · ${tls ? 'TLS' : 'no TLS'} · role ${role} `,
    canRead: 'can only read',
    canWrite: 'can write',
    errors: {
      name: 'Give it a name',
      host: 'A host is needed',
      socket: 'A socket folder is an absolute path',
      port: 'A port from 1 to 65535',
      database: 'A database is needed',
      user: 'A user is needed',
      sshHost: 'The bastion’s host is needed',
      tunnelHost: 'Through SSH: a host name, an alias or an IP address',
      sshSocket: 'SSH forwards TCP: use a host, not a socket',
      sshPort: 'A port from 1 to 65535, or empty',
      sshUser: 'Letters, digits, . _ and - (not first)',
      tooLong: (max: number) => `At most ${max} characters`,
      control: 'No control characters'
    },
    removedElsewhere: (name: string) => `${name} was removed in another window`,
    // Gone from this window without a sure removal: moved to another project's scope, or Databases set to Never.
    notShownHere: (name: string) => `${name} isn’t shown here anymore`,
    removeTitle: (name: string) => `Remove ${name}?`,
    removeBody: 'Its saved password goes too.',
    remove: 'Remove',
    fail: {
      test: "Couldn't test the connection",
      save: "Couldn't save the connection",
      remove: "Couldn't remove the connection"
    }
  }
} as const;

/** Windows names its own places and tools. macOS: as written. */
export const tdb = currentPlatform() === 'win32' ? localize(strings) : strings;
