import { randomBytes } from "node:crypto";

const LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const RESERVED = new Set([
  "www", "api", "admin", "drop", "app", "edge", "internal", "static",
]);

/** Returns an error message, or null if `name` is a valid, non-reserved DNS label. */
export function validateName(name: string): string | null {
  if (!LABEL.test(name)) {
    return `invalid site name "${name}": must be a lowercase DNS label`;
  }
  if (RESERVED.has(name)) return `site name "${name}" is reserved`;
  return null;
}

// ~300 adjectives × ~240 nouns × 65,536 hex tokens → a huge, friendly namespace.
const ADJECTIVES = (
  "aged alpine amber ancient arctic ashen autumn azure balmy billowing bitter black blazing " +
  "bleak blissful blue blushing bold boundless brave brawny breezy briny brisk bronze broad " +
  "broken bubbly burning calm candid caramel carefree cerulean charming cheery chestnut chilly " +
  "cinder citrine classic clean clear clever cloudy cobalt cold cool copper coral cosmic cozy " +
  "creamy crimson crisp crystal curly dainty damp dancing dapper daring dark dauntless dazzling " +
  "deep delicate dewy dim divine dreamy drifting dry dusky dusty eager early earnest earthy easy " +
  "ebony electric elegant emerald empty eternal evening fabled fading faint fair falling fancy " +
  "fearless feathery feisty fertile fiery fleet fleeting floating floral flowing fluffy fond foggy " +
  "fragrant free fresh frosty frozen gallant gentle gilded glacial glad gleaming glistening glossy " +
  "glowing golden graceful grand grassy gray green hallowed happy hardy hazel hazy hidden holy " +
  "honest humble icy idle indigo ivory jade jolly jovial joyful jubilant keen kind lacy late " +
  "lavender lazy leafy lilac limber lingering little lively lofty lone long loud lucent lucky lunar " +
  "lush magenta majestic mauve mellow merry mighty mild misty modest morning mossy muddy mute " +
  "mystic nameless navy nimble noble noisy northern ochre odd old olive opal orange ornate patient " +
  "peaceful pearly perky placid plain playful plucky polished prime pristine proud pure purple " +
  "quaint quick quiet radiant rapid raspy red regal restless rich rippling roaming rosy rough round " +
  "royal ruby rugged rustic sable sacred saffron sandy sapphire scarlet secret sepia serene shadowy " +
  "shady sharp sheer shimmering shiny shrill shy silent silken silver sleek slender small smoky " +
  "smooth snowy soft solar solemn solitary sparkling spirited spry spring square steady steep " +
  "stellar still stormy stout sublime subtle summer sunny super sweet swift tame tawny teal tender " +
  "throbbing tidal tidy tight timber tiny tranquil true tumbling twilight umber vast velvet verdant " +
  "vibrant violet vivid wandering warm weathered whispering white wild windy winter wise wispy " +
  "withered wooden young zealous zesty"
).split(" ");

const NOUNS = (
  "acorn anchor arbor arch arrow ash aspen atlas aurora autumn band basin bay beach beacon birch " +
  "bird blossom bluff boat bonus bough branch breeze bridge brook brush butterfly cabin cake canopy " +
  "canyon cape cascade castle cave cedar cell chasm cherry cliff cloud clover coast cobble comet " +
  "copse coral cove crag crater creek crest crystal current dale dawn dell delta dew disk dome dream " +
  "drift drizzle dune dusk eagle earth echo eddy ember fable falcon feather fern field fire firefly " +
  "fjord flame flare flint floe flower foam fog ford forest fountain fox frost galaxy gale garden " +
  "gate gem geyser glacier glade gleam glen glow gorge grass grotto grove gulf gully harbor hare " +
  "haven hawk haze heart heath hedge hill hollow horizon inlet island isle ivy jetty jungle knoll " +
  "lagoon lake lantern lava leaf ledge light lily lotus lynx maple marble marsh meadow mesa meteor " +
  "mist moon moor morning moss mound mountain nebula night nook oak oasis ocean orbit orchard otter " +
  "owl palm pasture peak pearl pebble pine pinnacle plain planet plateau plaza plume pond prairie " +
  "quarry quartz rain raven ravine reef reed ridge rill ripple river rock sage sand savanna sea " +
  "sequoia shadow shoal shore sky sleet slope smoke snow snowflake spark spire spring spruce star " +
  "steppe stone storm strand stream summit sun sunset surf swale swan thicket thunder tide timber " +
  "torrent trail tree tundra vale valley vapor violet vista voice vortex water waterfall wave " +
  "wetland wharf willow wind wood woodland zenith"
).split(" ");

/** A friendly, valid, collision-resistant site name: "twilight-cherry-8f3a". */
export function generateName(): string {
  const b = randomBytes(8);
  const adj = ADJECTIVES[b.readUInt16BE(0) % ADJECTIVES.length];
  const noun = NOUNS[b.readUInt16BE(2) % NOUNS.length];
  const token = b.readUInt16BE(4).toString(16).padStart(4, "0");
  return `${adj}-${noun}-${token}`;
}
