/**
 * Claude Code's rotating thinking-verb list. Used as the prefix on Friday's
 * Slack status while she's mid-thought — same vibe as the CLI's `✽ Pondering…`
 * line. Picked from the pool pseudo-randomly per update to keep it lively.
 */

export const THINKING_VERBS: readonly string[] = [
  "Accomplishing", "Actioning", "Actualizing", "Amazing", "Architecting",
  "Astrophaging", "Baking",
  "Beaming", "Beboppin'", "Befuddling", "Billowing", "Blanching",
  "Bloviating", "Boogieing", "Boondoggling", "Booping", "Bootstrapping",
  "Brewing", "Bunning", "Burrowing", "Calculating", "Canoodling",
  "Caramelizing", "Cascading", "Catapulting", "Cerebrating", "Channeling",
  "Channelling", "Choreographing", "Churning", "Clauding", "Coalescing",
  "Cogitating", "Combobulating", "Composing", "Computing", "Concocting",
  "Considering", "Contemplating", "Cooking", "Crafting", "Creating",
  "Crunching", "Crystallizing", "Cultivating", "Deciphering", "Deliberating",
  "Determining", "Dilly-dallying", "Discombobulating", "Doing", "Doodling",
  "Drizzling", "Ebbing", "Effecting", "Elucidating", "Embellishing",
  "Enchanting", "Envisioning", "Eridianing", "Evaporating", "Fermenting",
  "Fiddle-faddling", "Finagling", "Fist-bumping", "Flambéing",
  "Flibbertigibbeting", "Flowing", "Flummoxing",
  "Fluttering", "Forging", "Forming", "Frolicking", "Frosting",
  "Gallivanting", "Galloping", "Garnishing", "Generating", "Gesticulating",
  "Germinating", "Gitifying", "Grooving", "Gusting", "Hail-Marying",
  "Harmonizing",
  "Hashing", "Hatching", "Herding", "Honking", "Hullaballooing",
  "Hyperspacing", "Ideating", "Imagining", "Improvising", "Incubating",
  "Inferring", "Infusing", "Ionizing", "Jitterbugging", "Julienning",
  "Kneading", "Leavening", "Levitating", "Lollygagging", "Manifesting",
  "Marinating", "Meandering", "Metamorphosing", "Misting", "Moonwalking",
  "Moseying", "Mulling", "Mustering", "Musing", "Nebulizing",
  "Nesting", "Newspapering", "Noodling", "Nucleating", "Orbiting",
  "Orchestrating", "Osmosing", "Perambulating", "Percolating", "Perusing",
  "Philosophising", "Photosynthesizing", "Pollinating", "Pondering",
  "Pontificating", "Pouncing", "Precipitating", "Prestidigitating",
  "Processing", "Proofing", "Propagating", "Puttering", "Puzzling",
  "Quantumizing", "Questioning", "Razzle-dazzling", "Razzmatazzing",
  "Recombobulating",
  "Reticulating", "Roosting", "Ruminating", "Sautéing", "Scampering",
  "Schlepping", "Scurrying", "Seasoning", "Shenaniganing", "Shimmying",
  "Simmering", "Skedaddling", "Sketching", "Slithering", "Smooshing",
  "Sock-hopping", "Spelunking", "Spinning", "Sprouting", "Stewing",
  "Sublimating", "Swirling", "Swooping", "Symbioting", "Synthesizing",
  "Taumoebaing", "Tempering", "Thinking", "Thundering", "Tinkering",
  "Tomfoolering",
  "Topsy-turvying", "Transfiguring", "Transmuting", "Twisting", "Undulating",
  "Unfurling", "Unravelling", "Vibing", "Waddling", "Wandering",
  "Warping", "Whatchamacalliting", "Whirlpooling", "Whirring", "Whisking",
  "Wibbling", "Working", "Wrangling", "Xenoniting", "Zesting",
  "Zigzagging",
  "Looksmaxxing", "Softmaxxing", "Hardmaxxing", "Gymmaxxing", "Skinmaxxing",
  "Hairmaxxing", "Beardmaxxing", "Jawmaxxing", "Mewingmaxxing", "Heightmaxxing",
  "Fashionmaxxing", "Fragrancemaxxing", "Scentmaxxing", "Pheromonemaxxing", "Auramaxxing",
  "Rizzmaxxing", "Charismamaxxing", "Socialmaxxing", "Statusmaxxing", "Moneymaxxing",
  "Careermaxxing", "Networkmaxxing", "LinkedInmaxxing", "Productivitymaxxing", "Focusmaxxing",
  "Studymaxxing", "Brainmaxxing", "Sleepmaxxing", "Healthmaxxing", "Testosteronemaxxing",
  "T-maxxing", "Monkmaxxing", "Winterarcmaxxing", "Dopaminemaxxing", "Facemaxxing",
  "Bodymaxxing", "Leanmaxxing", "Musclemaxxing", "Aestheticmaxxing", "Groomingmaxxing",
  "Hygienemaxxing", "Teethmaxxing", "Smilemaxxing", "Posturemaxxing", "Voicemaxxing",
  "Eyebrowmaxxing", "Lashmaxxing", "Lipmaxxing", "Nosemaxxing", "Eyeareamaxxing",
  "Huntereyesmaxxing", "Tanmaxxing", "Skullmaxxing", "Datemaxxing", "Hingemaxxing",
  "Tindermaxxing", "Textmaxxing", "DMmaxxing", "Flirtmaxxing", "Confidencemaxxing",
  "Vibemaxxing", "Personalitymaxxing", "Humormaxxing", "Storymaxxing", "Yapmaxxing",
  "Yappingmaxxing", "Mysterymaxxing", "Silencemaxxing", "NPCmaxxing", "Sigma-maxxing",
  "Wealthmaxxing", "Incomemaxxing", "Salarymaxxing", "Jobmaxxing", "Interviewmaxxing",
  "Resumemaxxing", "Portfoliomaxxing", "Skillmaxxing", "Foundermaxxing", "Startupmaxxing",
  "Cloutmaxxing", "Brandmaxxing", "Twittermaxxing", "Xmaxxing", "Contentmaxxing",
  "Viralmaxxing", "Influencemaxxing", "Disciplinemaxxing", "Habitmaxxing", "Routine-maxxing",
  "Timemaxxing", "Deepworkmaxxing", "Notionmaxxing", "Calendarmaxxing", "Ankimaxxing",
  "Leetcodemaxxing", "DSAmaxxing", "Systemdesignmaxxing", "Readingmaxxing", "Journalingmaxxing",
  "Meditationmaxxing", "Prayermaxxing", "Faithmaxxing", "NoFapmaxxing", "Grindmaxxing",
  "Brainrotmaxxing", "Skibidimaxxing", "Gyattmaxxing", "Ohiomaxxing", "Fanumtaxmaxxing",
  "Rizzlermaxxing", "Chronicallyonlinemaxxing", "Slopmaxxing", "Meme-maxxing", "Ironymaxxing",
  "Cringemaxxing", "Delusionmaxxing", "Copemaxxing", "Hopemaxxing", "Joymaxxing",
  "Sillymaxxing", "Goblinmaxxing", "Gremlinmaxxing", "Buildmaxxing", "Shippingmaxxing",
  "Bugfixmaxxing", "Tokenmaxxing", "Promptmaxxing", "Survivalmaxxing", "Officemaxxing",
  "Proteinmaxxing", "mentally-stabbing-pranav"
] as const;

/**
 * Stable, per-thread-per-event verb picker. Using Date.now() >> 2 rotates the
 * pick every ~4 seconds so consecutive thinking updates within one turn tend
 * to share a verb (less flicker) while different turns get fresh verbs.whe
 */
export function pickThinkingVerb(seed?: number): string {
  const s = seed ?? Math.floor(Date.now() / 4000);
  const idx = Math.abs(s) % THINKING_VERBS.length;
  return THINKING_VERBS[idx]!;
}
