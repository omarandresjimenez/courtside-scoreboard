/**
 * English strings for the admin dashboard — the source of truth for wording
 * (also the fallback locale, see locale.ts's `translate`). Every key here
 * must also exist in es.ts with the same shape.
 */
const en = {
  common: {
    busy: 'Busy',
    available: 'Available',
    copy: 'Copy',
    remove: 'Remove',
    optionalPlaceholder: 'Optional…',
    player: 'player',
    players: 'players',
    row: 'row',
    rows: 'rows',
  },
  header: {
    defaultTournamentName: 'Tournament',
    titleSuffix: '— Admin',
    noTournamentSelected: 'Select a tournament in the desktop launcher first.',
    languageLabel: 'Language',
    themeLabel: 'Theme',
    themeDark: 'Dark',
    themeLight: 'Light',
  },
  clipboard: {
    copied: 'Link copied.',
    copyFailed: "Couldn't copy — select the link above and copy manually.",
  },
  roster: {
    cardHeading: 'Import players',
    cardHint:
      'Upload this tournament’s player list once (a CSV export from your tournament software) to pick players by name below instead of retyping them, and to restrict category to the ones players are actually registered for.',
    fileLabel: 'Player list CSV',
    fileAriaLabel: 'Player list CSV file',
    importedCount: '{{count}} {{playerWord}} imported for this tournament.',
    noUsableRows:
      'No usable rows found in that file — every row needs at least a first and last name.',
    importFailed: 'Failed to import players.',
    importNetworkFailure: 'Failed to import players — check the connection and try again.',
    importResult: 'Imported {{count}} {{playerWord}}, updated {{updated}}',
    importSkippedClause: ', skipped {{count}} {{rowWord}}',
  },
  courts: {
    heading: 'Courts',
    hint: 'Courts hold the TV and public links, and a match is assigned to one.',
    nameLabel: 'Court name',
    nameAriaLabel: 'Court label',
    namePlaceholder: 'e.g. Court 1…',
    addButton: 'Add court',
    createFailed: 'Failed to create court.',
    empty: 'No courts yet — add one above, then its TV link appears here.',
    codeOn: 'Code on',
    tvLinkAriaLabel: 'TV link',
    copyTvLink: 'Copy TV link for {{label}}',
    removed: 'Court removed.',
    removeFailed: 'Failed to remove court.',
    publicScoreLabel: 'Public score',
    publicScoreTitle: 'Anyone on the internet can open this',
    publicLinkAriaLabel: 'Public internet scoreboard link',
    copyPublicLink: 'Copy public internet link for {{label}}',
    broadcastLabel: 'Broadcast',
    broadcastTitle: 'Opens the camera on a phone',
    broadcastLinkAriaLabel: 'Broadcast link (court phone)',
    copyBroadcastLink: 'Copy broadcast link for {{label}}',
    broadcastQrTitle: 'QR code for the broadcast link to {{label}}',
    inUseSuffix: ' — in use',
  },
  umpires: {
    heading: 'Umpires',
    hint: 'An umpire can only be assigned to one live match at a time.',
    nameLabel: 'Umpire name',
    namePlaceholder: 'e.g. Ana Gómez…',
    addButton: 'Add umpire',
    addFailed: 'Failed to add umpire.',
    empty: 'No umpires yet — add one above to assign them to matches.',
    removed: 'Umpire removed.',
    removeFailed: 'Failed to remove umpire.',
    busySuffix: ' — busy',
  },
  trustCamera: {
    heading: 'Trust this phone for camera streaming',
    hint: 'The camera page needs a secure connection, so browsers show a one-time security warning the first time a phone opens it. Scan this once per phone that will ever film a match — after that, the warning won’t come back, even across restarts or a different court.',
    qrTitle: "QR code to install this server's camera-streaming certificate",
    scanCaption: 'Scan on the filming phone',
    showSteps: 'Show install steps',
    iphoneLabel: 'iPhone:',
    iphoneSteps:
      'tap the downloaded profile, then Settings → General → VPN & Device Management → tap it again → Install. Then Settings → General → About → Certificate Trust Settings → turn on full trust for “Courtside Scoreboard Local CA”.',
    androidLabel: 'Android:',
    androidSteps:
      'tap the downloaded file, choose “CA certificate” when asked what kind of certificate this is.',
  },
  createMatch: {
    heading: 'Create match',
    hint: 'The umpire link is shown once after creating, so keep this tab open.',
    formatLegend: 'Format',
    matchTypeLabel: 'Match type',
    singles: 'Singles',
    doubles: 'Doubles',
    scoringFormatLabel: 'Scoring format',
    presetStandard: 'Standard (21 / 30 / 11)',
    presetShort: 'Short (15 / 21 / 8)',
    categoryLabel: 'Category',
    chooseCategory: 'Choose category',
    categoryPlaceholder: 'e.g. MS U19…',
    categoryHintRoster:
      'From the imported player list — only categories a player is actually registered for.',
    categoryHintFree:
      'Free text. Shown on the TV, umpire and viewer screens in place of “singles”/“doubles”, which it already implies.',
    assignmentLegend: 'Assignment',
    courtLabel: 'Court',
    chooseCourt: 'Choose court',
    umpireLabel: 'Umpire',
    chooseUmpire: 'Choose umpire',
    playersLegend: 'Players',
    teamCountryHintRoster:
      "Team and country fill in automatically from the selected player's roster record — edit them if this pairing doesn’t match it.",
    teamCountryHintFree: 'Team and country are optional — club play usually has neither.',
    sidePlayerLegend: 'Side {{side}} player {{number}}',
    firstNameLabel: 'First name',
    lastNameLabel: 'Last name',
    sideTeamLegend: 'Side {{side}} team',
    teamLabel: 'Team',
    countryLabel: 'Country',
    submitCreating: 'Creating…',
    submitCreate: 'Create match',
    pickEveryPlayer: 'Pick every player from the list before creating the match.',
    createFailed: 'Failed to create match.',
    /* Eligibility — the roster checks in shared/players.ts. Keyed by the
       issue codes it returns, since the server cannot know the admin's
       language and so cannot write these sentences itself. */
    eligibility: {
      categoryNeedsSingles:
        'Category “{{category}}” is a singles event, but this match is set up as doubles.',
      categoryNeedsDoubles:
        'Category “{{category}}” is a doubles event, but this match is set up as singles.',
      notRegistered: 'A player on side {{side}} is not registered for category “{{category}}”.',
      genderNotAcceptedMale:
        'Category “{{category}}” does not accept a male player (side {{side}}).',
      genderNotAcceptedFemale:
        'Category “{{category}}” does not accept a female player (side {{side}}).',
      tooOld:
        'A player on side {{side}} is too old for category “{{category}}” (Under {{ageLimit}}).',
      mixedDoublesSide: 'Mixed doubles needs one male and one female player on side {{side}}.',
    },
    created: 'Match created.',
    umpireAccessIntro: 'Umpire access — give this only to the umpire, it won’t be shown again:',
    assignedCourt: 'Assigned court:',
    courtUnavailable: 'Court unavailable',
    umpireLinkLabel: 'Umpire link',
    umpireQrTitle: 'QR code for the umpire link to match {{matchId}}',
    umpireCaption: 'Umpire',
    copyUmpireLink: 'Copy umpire link',
  },
  matchHistory: {
    heading: 'Match history',
    rowsPerPage: 'Rows per page',
    empty: 'No matches yet.',
    courtFallback: 'Court',
    umpirePrefix: 'Umpire:',
    setLabel: 'Set {{number}}',
    retired: 'Retired',
    walkover: 'W.O.',
    sideFallback: 'Side {{side}}',
    previous: '← Previous',
    next: 'Next →',
    pageOf: 'Page {{current}} of {{total}}',
    matchScoreAriaLabel: 'Match score',
  },
  status: {
    finalizedRetired: 'Finalized — retired',
    finalizedWalkover: 'Finalized — walkover',
    finalized: 'Finalized',
    inProgress: 'Match in progress',
    ready: 'Match ready',
  },
  duration: {
    format: '{{minutes}} min {{seconds}} sec',
  },
  playerAutocomplete: {
    placeholder: 'Choose a player…',
  },
} satisfies import('./locale.js').Dictionary;

export default en;
