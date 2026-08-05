// Lovable AI Gateway helper (server-only).
// Uses fetch directly to avoid needing the AI SDK packages.

export interface GeneratedRoute {
  title: string;
  scenic_score: number;
  score_breakdown?: {
    natural_beauty: number;
    road_character: number;
    points_of_interest: number;
    theme_match: number;
    mood_match: number;
    diversity: number;
    rationale: string;
  };
  narrative: string;
  highlights: string[];
  waypoints: { name: string; lat: number; lng: number; description: string }[];
}

const GATEWAY_URL = "https://ai.gateway.lovable.dev/v1/chat/completions";

export async function generateScenicRoute(input: {
  start: { address: string; lat: number; lng: number };
  end: { address: string; lat: number; lng: number };
  mood: string;
  theme: string;
  extra_minutes: number;
  required_stops?: { address: string; lat: number; lng: number }[];
}): Promise<GeneratedRoute> {
  const key = process.env.LOVABLE_API_KEY;
  if (!key) throw new Error("Missing LOVABLE_API_KEY");

  const system = `You are Scenik, an AI scenic-route planner. You craft beautiful detours, not the fastest path.
Given a start, an end, a mood, a preferred theme, and how many extra minutes the driver is willing to spend,
suggest 2 to 4 scenic waypoints between the start and end, then score the route honestly.

Respond ONLY with valid minified JSON matching this exact schema (no markdown, no commentary):
{
  "title": string,
  "scenic_score": number,
  "score_breakdown": {
    "natural_beauty": number,         // 0-25: vistas, coast, mountains, forest, water
    "road_character": number,         // 0-20: winding/byway/low-traffic, named scenic routes
    "points_of_interest": number,     // 0-20: density & quality of viewpoints/landmarks
    "theme_match": number,            // 0-15: fit to requested theme
    "mood_match": number,             // 0-10: fit to requested mood
    "diversity": number,              // 0-10: variety of landscapes vs sameness
    "rationale": string               // 1-2 sentences, cite concrete features
  },
  "narrative": string,
  "highlights": string[],
  "waypoints": [{ "name": string, "lat": number, "lng": number, "description": string }]
}

SCORING RULES (be strict and calibrated — most routes are not 90+):
- scenic_score MUST equal the sum of the six breakdown components (max 100). Do not invent the total.
- Calibration anchors:
  • 90-100: world-class (e.g. Big Sur Highway 1, Going-to-the-Sun, Amalfi Coast).
  • 75-89: excellent regional drive with multiple standout stretches.
  • 60-74: pleasant, mixing scenic segments with ordinary road.
  • 40-59: mostly utilitarian with a few nice moments.
  • <40: largely highway/urban/industrial.
- Penalize routes dominated by interstates, sprawl, or flat featureless terrain even if a stop is nice.
- Reward named scenic byways, coastal/ridge/river roads, and tightly-clustered high-quality stops.
- "theme_match" and "mood_match" reflect FIT to "${input.theme}" / "${input.mood}", not general prettiness.
- "rationale" must cite specific named roads, terrain, or landmarks — no generic praise.

CONTENT RULES:
- "narrative": 2-3 evocative sentences describing the journey vibe.
- "highlights": 3-5 short bullet phrases of defining features the driver will see.
- "waypoints": REAL places with accurate lat/lng. No fabrications. If the corridor doesn't fit the theme, reflect that with a lower theme_match rather than inventing stops.`;

  const fastest = input.extra_minutes === 0;
  const stops = input.required_stops ?? [];
  const stopsBlock = stops.length
    ? `\nREQUIRED stops (the driver MUST visit these in this exact order, between start and end):\n${stops.map((s, i) => `  ${i + 1}. ${s.address} (${s.lat}, ${s.lng})`).join("\n")}\nInclude every required stop in "waypoints" in the given order. You may add additional scenic waypoints between them, but never drop or reorder a required stop.`
    : "";
  const user = `Plan a ${fastest ? "DIRECT (fastest) drive — no scenic detours" : "scenic drive"}.
Start: ${input.start.address} (${input.start.lat}, ${input.start.lng})
End: ${input.end.address} (${input.end.lat}, ${input.end.lng})
Mood: ${input.mood}
Theme: ${input.theme}
Extra time the driver will spend: ${input.extra_minutes} minutes${stopsBlock}
${fastest && stops.length === 0 ? "The driver has NOT chosen a mood or theme. Return the fastest direct route: use 0 waypoints (empty array), keep narrative concise and practical, and score honestly (likely a low scenic_score). Title should reflect a direct drive." : ""}
Return the JSON.`;

  let res: Response;
  try {
    res = await fetch(GATEWAY_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Lovable-API-Key": key,
      },
      body: JSON.stringify({
        model: "google/gemini-3-flash-preview",
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        response_format: { type: "json_object" },
      }),
    });
  } catch {
    throw new Error("NETWORK");
  }

  if (res.status === 429) throw new Error("AI_RATE_LIMIT");
  if (res.status === 402) throw new Error("AI_CREDITS");
  if (!res.ok) {
    await res.text().catch(() => "");
    throw new Error("AI_FAILED");
  }

  const data = await res.json().catch(() => null);
  const content: string = data?.choices?.[0]?.message?.content ?? "";
  let parsed: GeneratedRoute | null = null;
  try {
    parsed = JSON.parse(content);
  } catch {
    const match = content.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        parsed = JSON.parse(match[0]);
      } catch {
        parsed = null;
      }
    }
  }
  if (!parsed || typeof parsed.title !== "string" || typeof parsed.narrative !== "string") {
    // Fastest mode is non-creative — synthesize a safe fallback so the user
    // never sees "couldn't understand" when they just wanted a direct drive.
    if (fastest) {
      parsed = {
        title: "Direct drive",
        scenic_score: 20,
        score_breakdown: {
          natural_beauty: 5,
          road_character: 4,
          points_of_interest: 3,
          theme_match: 0,
          mood_match: 0,
          diversity: 2,
          rationale: "Fastest direct route — no scenic detours requested.",
        },
        narrative: "A straightforward drive from start to finish.",
        highlights: ["Fastest available route", "No detours"],
        waypoints: [],
      };
    } else {
      throw new Error("AI_INVALID");
    }
  }

  // Sanity check
  if (!parsed.waypoints || !Array.isArray(parsed.waypoints)) {
    parsed.waypoints = [];
  }
  // Reconcile total with breakdown sum (model often drifts)
  const b = parsed.score_breakdown;
  if (b) {
    const clamp = (n: number, max: number) =>
      Math.max(0, Math.min(max, Math.round(Number(n) || 0)));
    b.natural_beauty = clamp(b.natural_beauty, 25);
    b.road_character = clamp(b.road_character, 20);
    b.points_of_interest = clamp(b.points_of_interest, 20);
    b.theme_match = clamp(b.theme_match, 15);
    b.mood_match = clamp(b.mood_match, 10);
    b.diversity = clamp(b.diversity, 10);
    parsed.scenic_score =
      b.natural_beauty +
      b.road_character +
      b.points_of_interest +
      b.theme_match +
      b.mood_match +
      b.diversity;
  } else {
    parsed.scenic_score = Math.max(0, Math.min(100, Math.round(parsed.scenic_score ?? 0)));
  }
  return parsed;
}

// Speed limits from OpenStreetMap via Overpass API (ODbL — free for any use
// with attribution). Compliant with consumer apps, unlike Google Roads API
// which is restricted to the Asset Tracking license tier.
export async function getSpeedLimitKmh(input: {
  lat: number;
  lng: number;
}): Promise<number | null> {
  try {
    // Find the nearest highway way within 25m that has a maxspeed tag.
    const query = `[out:json][timeout:8];way(around:25,${input.lat},${input.lng})[highway][maxspeed];out tags 1;`;
    const res = await fetch("https://overpass-api.de/api/interpreter", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": "Scenik-ScenicRoutes/1.0",
      },
      body: `data=${encodeURIComponent(query)}`,
    });
    if (!res.ok) return null;
    const data = await res.json().catch(() => null);
    const raw: string | undefined = data?.elements?.[0]?.tags?.maxspeed;
    if (!raw) return null;

    // OSM maxspeed values: "50", "30 mph", "50 km/h", "RO:urban", "none", "signals".
    const trimmed = raw.trim().toLowerCase();
    if (trimmed === "none" || trimmed === "signals" || trimmed === "variable") return null;
    const m = trimmed.match(/^(\d+(?:\.\d+)?)\s*(mph|km\/h|kmh|kph)?$/);
    if (!m) return null;
    const n = parseFloat(m[1]);
    if (!isFinite(n) || n <= 0) return null;
    const unit = m[2];
    const kmh = unit === "mph" ? n * 1.609344 : n;
    return Math.round(kmh);
  } catch {
    return null;
  }
}

// ----- Lightweight AI text helper -----
async function aiText(system: string, user: string): Promise<string> {
  const key = process.env.LOVABLE_API_KEY;
  if (!key) throw new Error("Missing LOVABLE_API_KEY");
  const res = await fetch(GATEWAY_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Lovable-API-Key": key },
    body: JSON.stringify({
      model: "google/gemini-3-flash-preview",
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
  });
  if (!res.ok) throw new Error("AI_FAILED");
  const data = await res.json().catch(() => null);
  return String(data?.choices?.[0]?.message?.content ?? "").trim();
}

export async function getWaypointFacts(input: {
  name: string;
  lat: number;
  lng: number;
  theme?: string;
  language?: string;
}): Promise<{ facts: string }> {
  const lang = input.language || "English";
  const system = `You are a warm, well-traveled tour guide riding shotgun. Given a landmark or place, share 2-3 short, interesting, true facts that a driver would love to hear as they arrive. Keep it under 60 words, conversational, no bullet points, no preamble like "Here are facts". Reply in ${lang}.`;
  const user = `Place: ${input.name}\nCoordinates: ${input.lat.toFixed(4)}, ${input.lng.toFixed(4)}${input.theme ? `\nDriver's theme of interest: ${input.theme}` : ""}\nGive the facts.`;
  const text = await aiText(system, user);
  return { facts: text.replace(/^"|"$/g, "") };
}

export async function recommendThemes(input: {
  start: string;
  end: string;
  available: string[];
}): Promise<{ themes: string[] }> {
  const system = `You are a route-styling advisor. Pick 3-5 themes from the provided list that genuinely match the actual geography between the start and the end. Output ONLY valid minified JSON: {"themes": string[]}. Each item MUST match the list exactly (case-sensitive). No commentary.

GEOGRAPHY RULES — be strict, do not pick themes that don't fit the terrain:
- "Coastal" / "Lighthouse": ONLY if the corridor actually touches an ocean, sea, or major bay within ~30 km of the road. Never for landlocked interiors.
- "Mountain": ONLY if the corridor crosses real mountains or significant ranges (e.g. Rockies, Alps, Cascades, Pyrenees, Andes, Appalachians at elevation). Not for rolling hills.
- "Lakeside": only if a notable lake or chain of lakes is on the route.
- "Waterfalls": only if known falls are accessible from the corridor.
- "Desert": only for arid regions (US Southwest, Sahara, Atacama, Australian Outback, etc.).
- "Forested" / "Wildlife": strong picks for landlocked, wooded, rural, or wilderness corridors with no coast — favor these over "Coastal" inland.
- "Vineyard & Winery": only in genuine wine regions.
- "Countryside" / "Small Towns": safe defaults for rural inland drives.
- "Historic" / "Architectural" / "Literary" / "Arts & Galleries" / "Music Heritage" / "Film Locations": only when the corridor has documented heritage in that category.
- "Foodie": only when the regions have a recognized food culture worth detouring for.
- "Garden & Botanical" / "Bridges & Byways" / "Stargazing": only when those specific features exist along the route.

If a theme is borderline, leave it out. Prefer a tight list of true fits over filling 5 slots.`;
  const user = `Start: ${input.start}\nEnd: ${input.end}\nAvailable themes: ${input.available.join(", ")}\nReturn 3-5 themes that genuinely match this corridor's geography.`;

  const text = await aiText(system, user);
  try {
    const parsed = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] ?? text);
    const list = Array.isArray(parsed?.themes) ? parsed.themes : [];
    const filtered = list.filter(
      (t: unknown): t is string => typeof t === "string" && input.available.includes(t),
    );
    return { themes: filtered.slice(0, 5) };
  } catch {
    return { themes: [] };
  }
}
