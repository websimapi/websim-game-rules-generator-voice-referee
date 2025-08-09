import { set, get, del, keys, update } from "idb-keyval";

// Persistent keys
const GAMES_KEY_PREFIX = "game_rules/";
const LAST_ACTIVE_GAME_KEY = "last_active_game";
const MAX_HISTORY = 10;

// UI elements
const gameNameEl = document.getElementById("gameName");
const rulesInputEl = document.getElementById("rulesInput");
const micRulesBtn = document.getElementById("micRulesBtn");
const micRulesStatus = document.getElementById("micRulesStatus");
const summarizeBtn = document.getElementById("summarizeBtn");
const clearRulesBtn = document.getElementById("clearRulesBtn");
const summaryContainer = document.getElementById("summaryContainer");
const summaryPreview = document.getElementById("summaryPreview");
const saveRulesBtn = document.getElementById("saveRulesBtn");
const gamesSelect = document.getElementById("gamesSelect");
const deleteGameBtn = document.getElementById("deleteGameBtn");

const activeGameNameEl = document.getElementById("activeGameName");
const chatLogEl = document.getElementById("chatLog");
const chatInputEl = document.getElementById("chatInput");
const micChatBtn = document.getElementById("micChatBtn");
const micChatStatus = document.getElementById("micChatStatus");
const sendBtn = document.getElementById("sendBtn");
const ttsToggle = document.getElementById("ttsToggle");

const exportBtn = document.getElementById("exportBtn");
const importInput = document.getElementById("importInput");

// Hands-free UI
const handsFreeBtn = document.getElementById("handsFreeBtn");
const handsFreeStatus = document.getElementById("handsFreeStatus");

// New mobile/PTT UI
const pttRow = document.getElementById("pttRow");
const pttBtn = document.getElementById("pttBtn");
const pttStatus = document.getElementById("pttStatus");
const srSupportBanner = document.getElementById("srSupportBanner");
const srSupportText = document.getElementById("srSupportText");
const quickCommands = document.getElementById("quickCommands");

// Env detection
const ua = navigator.userAgent || "";
const isIOS = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const isAndroid = /Android/i.test(ua);
const isMobile = /Mobi|Android|iPhone|iPad|iPod/i.test(ua);

// Conversation state
let conversationHistory = []; // [{ role, content }]
let activeGameId = null;
let activeGameData = null;

// Web Speech API setup (SpeechRecognition)
const SpeechRecognition =
  window.SpeechRecognition || window.webkitSpeechRecognition;
const hasSpeechRecognition = !!SpeechRecognition;

// Hands-free state
let handsFreeActive = false;
let handsFreeRecognizer = null;
let suppressRecognizer = false; // pause listening while TTS is speaking
let pttRecognizer = null;
let pttActive = false;

// Prime audio on first interaction (helps mobile autoplay policies)
let audioPrimed = false;
function primeAudio() {
  if (audioPrimed) return;
  audioPrimed = true;
  try {
    // Some browsers require resume() after a user gesture
    if (window.speechSynthesis?.paused) window.speechSynthesis.resume();
    // A no-op utterance to unlock
    const u = new SpeechSynthesisUtterance("");
    window.speechSynthesis.speak(u);
    window.speechSynthesis.cancel();
  } catch (_) {}
}

// TTS helper
function speak(text) {
  if (!ttsToggle.checked) return;
  if (!("speechSynthesis" in window)) return;
  primeAudio();
  // Cancel any ongoing speech
  window.speechSynthesis.cancel();
  const utter = new SpeechSynthesisUtterance(text);
  utter.rate = 1.0;
  utter.pitch = 1.0;
  window.speechSynthesis.speak(utter);
}
async function speakAsync(text) {
  if (!ttsToggle.checked || !("speechSynthesis" in window) || !text) return;
  primeAudio();
  // Temporarily pause hands-free recognizer to avoid self-hearing
  const wasActive = handsFreeActive && handsFreeRecognizer;
  if (wasActive) {
    suppressRecognizer = true;
    try { handsFreeRecognizer.stop(); } catch (_) {}
  }
  await new Promise((resolve) => {
    window.speechSynthesis.cancel();
    const utter = new SpeechSynthesisUtterance(text);
    utter.rate = 1.0;
    utter.pitch = 1.0;
    utter.onend = resolve;
    utter.onerror = resolve;
    window.speechSynthesis.speak(utter);
  });
  if (wasActive) {
    // Give the browser a brief moment before restarting recognition
    await new Promise((r) => setTimeout(r, 200));
    suppressRecognizer = false;
    try { handsFreeRecognizer.start(); } catch (_) {}
  }
}

// Utility: scroll chat to bottom
function scrollChatToBottom() {
  chatLogEl.scrollTop = chatLogEl.scrollHeight;
}

// Utility: render a chat message
function renderMsg(role, content) {
  const wrap = document.createElement("div");
  wrap.className = `msg ${role === "user" ? "user" : "bot"}`;
  wrap.textContent = content;
  chatLogEl.appendChild(wrap);
  scrollChatToBottom();
}

// Utility: ensure we have an active game selected in UI
async function refreshGamesList() {
  const all = await listAllGames();
  // Clear
  gamesSelect.innerHTML = "";
  if (all.length === 0) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "No games saved";
    gamesSelect.appendChild(opt);
    gamesSelect.disabled = true;
    deleteGameBtn.disabled = true;
    if (!activeGameId) {
      activeGameNameEl.textContent = "None selected";
    }
    return;
  }
  gamesSelect.disabled = false;
  deleteGameBtn.disabled = false;

  for (const { id, data } of all) {
    const opt = document.createElement("option");
    opt.value = id;
    opt.textContent = data.name || id;
    gamesSelect.appendChild(opt);
  }

  // Restore last active
  const last = (await get(LAST_ACTIVE_GAME_KEY)) || null;
  if (last && all.find((g) => g.id === last)) {
    gamesSelect.value = last;
    await setActiveGame(last);
  } else {
    gamesSelect.value = all[0].id;
    await setActiveGame(all[0].id);
  }
}

async function listAllGames() {
  const allKeys = await keys();
  const gameKeys = allKeys.filter((k) =>
    typeof k === "string" ? k.startsWith(GAMES_KEY_PREFIX) : false
  );
  const entries = [];
  for (const k of gameKeys) {
    const data = await get(k);
    if (data) {
      entries.push({ id: k, data });
    }
  }
  // Sort by updated desc
  entries.sort((a, b) => (b.data.updatedAt || 0) - (a.data.updatedAt || 0));
  return entries;
}

async function setActiveGame(id) {
  activeGameId = id || null;
  activeGameData = id ? await get(id) : null;
  await set(LAST_ACTIVE_GAME_KEY, activeGameId);
  activeGameNameEl.textContent = activeGameData?.name || "None selected";
  // Reset conversation when switching games to keep context clean but keep last few msgs optional
  conversationHistory = [];
  chatLogEl.innerHTML = "";
  if (activeGameData) {
    renderMsg(
      "bot",
      `Now refereeing: ${activeGameData.name}.
I have this game's rules in memory. Ask me about setup, valid moves, scoring, fouls, disputes, or edge cases.`
    );
  }
}

async function deleteActiveGame() {
  if (!activeGameId) return;
  const name = activeGameData?.name || "this game";
  if (!confirm(`Delete "${name}" from memory? This cannot be undone.`)) return;
  await del(activeGameId);
  activeGameId = null;
  activeGameData = null;
  await refreshGamesList();
  renderMsg("bot", `Deleted ${name}.`);
}

// Summarize & validate rules with LLM into structured JSON
async function summarizeRules() {
  const name = (gameNameEl.value || "").trim();
  const desc = (rulesInputEl.value || "").trim();
  if (!desc) {
    alert("Please provide a rules description (type or speak) first.");
    return;
  }
  summarizeBtn.disabled = true;
  summarizeBtn.textContent = "Summarizing...";
  summaryContainer.classList.add("hidden");
  summaryPreview.textContent = "";

  try {
    const systemPrompt = `You are an expert rules analyst and referee.
Extract, normalize, and validate board/party/role-playing game rules from free-form text.
Output structured JSON only, no extra text. Be precise and complete.`;

    const content = [
      {
        type: "text",
        text: `Convert the following free-form game rules into structured JSON.

Respond with JSON that matches exactly this TypeScript-like schema:
{
  "name": string;                // inferred or provided game name
  "summary": string;             // brief overview
  "setup": string;               // initial setup
  "components": string[];        // pieces, decks, dice, boards, tokens
  "turnStructure": string;       // how turns/rounds proceed
  "actions": string[];           // allowed actions per turn
  "scoring": string;             // how points or progress are awarded
  "fouls": string[];             // illegal moves or penalties
  "winConditions": string[];     // conditions to end and declare winner
  "edgeCases": string[];         // tie-breaks, rare rules, exceptions
  "variants": string[];          // optional modes or house rules
  "glossary": { [term: string]: string }; // definitions of terms
  "safetyNotes": string[];       // if applicable
  "version": number;             // start at 1
}
If some fields aren't applicable, return sensible empties. Use concise but explicit language.

Game Name (optional): ${name || "(not provided)"}

Rules Description:
${desc}
`,
      },
    ];

    const completion = await websim.chat.completions.create({
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content, json: true },
      ],
      // json: true is passed per message in this environment style
    });

    let parsed;
    try {
      parsed = JSON.parse(completion.content);
    } catch (e) {
      // Try to salvage JSON if model included extra
      const asText = String(completion.content || "");
      const start = asText.indexOf("{");
      const end = asText.lastIndexOf("}");
      if (start >= 0 && end > start) {
        parsed = JSON.parse(asText.slice(start, end + 1));
      } else {
        throw e;
      }
    }

    // Normalize
    parsed.name = parsed.name || name || "Untitled Game";
    parsed.version = typeof parsed.version === "number" ? parsed.version : 1;
    parsed.updatedAt = Date.now();

    summaryPreview.textContent = JSON.stringify(parsed, null, 2);
    summaryContainer.classList.remove("hidden");
    saveRulesBtn.onclick = async () => {
      await saveGameToMemory(parsed);
    };
  } catch (err) {
    console.error(err);
    alert("Failed to summarize rules. Please try again.");
  } finally {
    summarizeBtn.disabled = false;
    summarizeBtn.textContent = "Summarize & Validate";
  }
}

async function saveGameToMemory(gameJson) {
  const idSafe =
    GAMES_KEY_PREFIX +
    (gameJson.name || "Untitled Game")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "");
  // If exists, bump version
  const existing = await get(idSafe);
  if (existing) {
    gameJson.version = (existing.version || 1) + 1;
  }
  gameJson.updatedAt = Date.now();
  await set(idSafe, gameJson);
  await refreshGamesList();
  gamesSelect.value = idSafe;
  await setActiveGame(idSafe);
  summaryContainer.classList.add("hidden");
  summaryPreview.textContent = "";
  renderMsg("bot", `Saved "${gameJson.name}" to memory (v${gameJson.version}).`);
}

// LLM chat as a referee, using active game rules
async function sendChat(userText) {
  if (!userText.trim()) return;
  if (!activeGameData) {
    alert("Please select or save a game first.");
    return;
  }

  renderMsg("user", userText);

  // Push to conversation history
  conversationHistory.push({ role: "user", content: userText });
  conversationHistory = conversationHistory.slice(-MAX_HISTORY);

  // Build system message conditioning with saved rules
  const systemMessage = {
    role: "system",
    content:
      `You are an impartial, concise referee and rules coach for the currently active game.\n` +
      `1) Always ground your answer in the provided RULES JSON below.\n` +
      `2) If the rules don't cover the question, state the gap and propose a fair, consistent ruling.\n` +
      `3) When resolving disputes, cite specific rule parts.\n` +
      `4) Prefer step-by-step reasoning, but keep the final answer succinct.\n` +
      `5) If user asks to update rules, ask for confirmation and produce a new JSON patch.\n\n` +
      `RULES JSON:\n` +
      JSON.stringify(activeGameData, null, 2),
  };

  // Build messages slice: include system + last N messages
  const messages = [systemMessage, ...conversationHistory];

  // Call LLM
  sendBtn.disabled = true;
  sendBtn.textContent = "Thinking...";
  try {
    const completion = await websim.chat.completions.create({
      messages,
    });
    const botReply = completion.content || "(No response)";
    // Add to history
    conversationHistory.push({ role: "assistant", content: botReply });
    conversationHistory = conversationHistory.slice(-MAX_HISTORY);
    renderMsg("bot", botReply);
    speak(botReply);
  } catch (err) {
    console.error(err);
    renderMsg("bot", "Error contacting referee. Please try again.");
  } finally {
    sendBtn.disabled = false;
    sendBtn.textContent = "Send";
  }
}

// Microphone handling
function startContinuousDictation(targetEl, statusEl) {
  if (!hasSpeechRecognition) {
    alert("Speech recognition is not supported in this browser.");
    return null;
  }
  const rec = new SpeechRecognition();
  rec.lang = "en-US";
  rec.continuous = true;
  rec.interimResults = true;

  let listening = true;
  let interim = "";

  rec.onstart = () => {
    statusEl.textContent = "Listening…";
  };
  rec.onerror = (e) => {
    statusEl.textContent = `Error: ${e.error}`;
  };
  rec.onend = () => {
    statusEl.textContent = "Idle";
    if (listening) {
      // auto-restart for continuous capture (Android Chrome friendly)
      try {
        rec.start();
      } catch (_) {}
    }
  };
  rec.onresult = (event) => {
    interim = "";
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const res = event.results[i];
      if (res.isFinal) {
        const text = res[0].transcript;
        targetEl.value = (targetEl.value + " " + text).trim();
      } else {
        interim += res[0].transcript;
      }
    }
    statusEl.textContent = interim ? `Listening… (${interim})` : "Listening…";
  };

  try { rec.start(); } catch (_) {}

  return () => {
    listening = false;
    try {
      rec.stop();
    } catch (_) {}
  };
}

// Push-to-talk (single utterance) recognition for mobile
function createPTTRecognizer() {
  if (!hasSpeechRecognition) return null;
  const rec = new SpeechRecognition();
  rec.lang = "en-US";
  rec.continuous = false; // single utterance
  rec.interimResults = true;

  rec.onstart = () => {
    pttStatus.textContent = "Listening…";
    pttBtn.classList.add("recording");
  };
  rec.onerror = (e) => {
    pttStatus.textContent = `Error: ${e.error}`;
    pttBtn.classList.remove("recording");
    pttActive = false;
  };
  rec.onend = () => {
    if (!pttActive) {
      pttStatus.textContent = "Press and hold, then release to send";
      pttBtn.classList.remove("recording");
    }
  };
  rec.onresult = async (event) => {
    let interim = "";
    let finalHeard = "";
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const res = event.results[i];
      if (res.isFinal) {
        finalHeard += res[0].transcript;
      } else {
        interim += res[0].transcript;
      }
    }
    if (interim) {
      pttStatus.textContent = `Listening… (${interim})`;
    }
    if (finalHeard.trim()) {
      renderMsg("user", finalHeard.trim());
      // Resolve any follow-ups or route
      const handled = await resolvePendingFollowup(finalHeard.trim());
      if (!handled) {
        const state = await fillSavedGamesInState(getStateSnapshot());
        try {
          const route = await routeVoiceCommand(finalHeard.trim(), state);
          await handleRoutedAction(route);
        } catch (err) {
          console.error(err);
          await speakAsync("I had trouble understanding that. Please try again.");
        }
      }
    }
  };

  return rec;
}

// LLM router to interpret voice commands into actions (JSON-only)
async function routeVoiceCommand(transcript, stateSnapshot) {
  const sys = `You are a voice command router for a hands-free game-rules app.
- Output strictly JSON and nothing else.
- Infer the user's intent from their utterance and the current app state.
- Prefer clear, single-step actions. If you truly need info, ask a short follow-up.

JSON schema:
{
  "intent": "ask_referee" | "dictate_rules" | "summarize_rules" | "save_rules" | "select_game" | "delete_game" | "clear_rules" | "export" | "toggle_tts" | "help" | "stop",
  "say": string,                 // what the assistant should speak to the user (concise)
  "slots": {
    "question"?: string,         // for ask_referee
    "rulesChunk"?: string,       // for dictate_rules
    "gameName"?: string,         // for save_rules/select_game/delete_game
    "tts"?: "on" | "off"         // for toggle_tts
  }
}`;

  const userContent = [
    {
      type: "text",
      text:
        `Utterance: "${transcript}"\n` +
        `STATE JSON:\n` +
        JSON.stringify(stateSnapshot, null, 2) +
        `\nRespond strictly with JSON that fits the schema.`,
    },
  ];

  const completion = await websim.chat.completions.create({
    messages: [
      { role: "system", content: sys },
      { role: "user", content: userContent, json: true },
    ],
  });

  let parsed;
  try {
    parsed = JSON.parse(completion.content);
  } catch {
    // fallback minimal
    parsed = { intent: "ask_referee", say: "", slots: { question: transcript } };
  }
  parsed.intent = parsed.intent || "ask_referee";
  parsed.slots = parsed.slots || {};
  parsed.say = typeof parsed.say === "string" ? parsed.say : "";
  return parsed;
}

// Snapshot current app state to help the router
function getStateSnapshot() {
  return {
    hasActiveGame: !!activeGameData,
    activeGameName: activeGameData?.name || null,
    savedGames: [],
    rulesTextLen: (rulesInputEl.value || "").trim().length,
    ttsEnabled: !!ttsToggle.checked,
  };
}
async function fillSavedGamesInState(state) {
  const all = await listAllGames();
  state.savedGames = all.map((g) => g.data?.name || g.id.replace(GAMES_KEY_PREFIX, ""));
  return state;
}

// Handle routed action
async function handleRoutedAction(route) {
  const { intent, slots, say } = route;
  if (say) await speakAsync(say);

  switch (intent) {
    case "dictate_rules": {
      const chunk = (slots.rulesChunk || "").trim();
      if (chunk) {
        rulesInputEl.value = (rulesInputEl.value + "\n" + chunk).trim();
        handsFreeStatus.textContent = "Captured rules chunk.";
      } else {
        await speakAsync("Please dictate the rules details.");
      }
      break;
    }
    case "summarize_rules": {
      await summarizeRules();
      break;
    }
    case "save_rules": {
      let nm = (slots.gameName || gameNameEl.value || "").trim();
      if (!nm) {
        await speakAsync("What should I name this game?");
        // Next user utterance will likely be just the name; we can set a temporary mode.
        pendingFollowup = { type: "gameNameForSave" };
      } else {
        gameNameEl.value = nm;
        // Try to use the existing summary JSON if visible, otherwise attempt to summarize first
        if (!summaryContainer.classList.contains("hidden") && summaryPreview.textContent.trim()) {
          try {
            const parsed = JSON.parse(summaryPreview.textContent);
            await saveGameToMemory(parsed);
          } catch {
            await summarizeRules();
            // try again
            if (summaryPreview.textContent.trim()) {
              const parsed = JSON.parse(summaryPreview.textContent);
              await saveGameToMemory(parsed);
            }
          }
        } else {
          await summarizeRules();
          if (summaryPreview.textContent.trim()) {
            const parsed = JSON.parse(summaryPreview.textContent);
            await saveGameToMemory(parsed);
          }
        }
      }
      break;
    }
    case "select_game": {
      const all = await listAllGames();
      const targetName = (slots.gameName || "").toLowerCase();
      if (!targetName) {
        await speakAsync("Please say the game name to select.");
        pendingFollowup = { type: "selectGameName" };
        break;
      }
      const found = all.find((g) => (g.data?.name || "").toLowerCase() === targetName)
        || all.find((g) => (g.data?.name || "").toLowerCase().includes(targetName));
      if (found) {
        await setActiveGame(found.id);
        await speakAsync(`Now refereeing ${found.data.name}.`);
      } else {
        await speakAsync(`I couldn't find ${slots.gameName}.`);
      }
      break;
    }
    case "delete_game": {
      if (!slots.gameName && activeGameData) {
        // Confirm delete active
        await speakAsync(`Do you want me to delete ${activeGameData.name}? Say confirm to proceed.`);
        pendingFollowup = { type: "confirmDeleteActive" };
        break;
      }
      const all = await listAllGames();
      const target = (slots.gameName || "").toLowerCase();
      const found = all.find((g) => (g.data?.name || "").toLowerCase() === target);
      if (found) {
        await del(found.id);
        await refreshGamesList();
        await speakAsync(`Deleted ${found.data.name}.`);
      } else {
        await speakAsync("I couldn't find that game to delete.");
      }
      break;
    }
    case "clear_rules": {
      rulesInputEl.value = "";
      await speakAsync("Cleared the rules text.");
      break;
    }
    case "export": {
      await exportAll();
      await speakAsync("Exported your saved games.");
      break;
    }
    case "toggle_tts": {
      if (slots.tts === "on") ttsToggle.checked = true;
      if (slots.tts === "off") ttsToggle.checked = false;
      await speakAsync(`Text to speech is now ${ttsToggle.checked ? "on" : "off"}.`);
      break;
    }
    case "help": {
      const help =
        "You can say: dictate rules, summarize rules, save rules as Game Name, select game Game Name, ask the referee a question, export, or stop.";
      await speakAsync(help);
      break;
    }
    case "stop": {
      stopHandsFree();
      await speakAsync("Hands-free mode stopped.");
      break;
    }
    case "ask_referee":
    default: {
      const q = (slots.question || "").trim() || "";
      if (!q) {
        await speakAsync("What is your question for the referee?");
        pendingFollowup = { type: "askRefereeQuestion" };
        break;
      }
      await sendChat(q);
      break;
    }
  }
}

// Pending follow-ups simple state
let pendingFollowup = null;
async function resolvePendingFollowup(text) {
  const t = (text || "").trim();
  if (!pendingFollowup) return false;
  const pf = pendingFollowup;
  pendingFollowup = null;

  if (pf.type === "gameNameForSave") {
    gameNameEl.value = t;
    await speakAsync(`Saving rules as ${t}.`);
    // proceed to save
    await handleRoutedAction({ intent: "save_rules", slots: { gameName: t }, say: "" });
    return true;
  }
  if (pf.type === "askRefereeQuestion") {
    await handleRoutedAction({ intent: "ask_referee", slots: { question: t }, say: "" });
    return true;
  }
  if (pf.type === "selectGameName") {
    await handleRoutedAction({ intent: "select_game", slots: { gameName: t }, say: "" });
    return true;
  }
  if (pf.type === "confirmDeleteActive") {
    if (t.toLowerCase().includes("confirm") || t.toLowerCase().includes("yes")) {
      await deleteActiveGame();
    } else {
      await speakAsync("Okay, I will not delete it.");
    }
    return true;
  }
  return false;
}

// Hands-free continuous listener
function startHandsFree() {
  if (!hasSpeechRecognition) {
    // Fall back to PTT guidance
    handsFreeStatus.textContent = "Speech recognition not available.";
    srSupportBanner.classList.remove("hidden");
    return;
  }
  if (handsFreeActive) return;

  handsFreeActive = true;
  handsFreeBtn.textContent = "⏹ Stop Hands-free";
  handsFreeStatus.textContent = "Listening…";
  handsFreeRecognizer = new SpeechRecognition();
  handsFreeRecognizer.lang = "en-US";
  // On mobile, continuous can be unreliable; use continuous on Android only
  handsFreeRecognizer.continuous = isAndroid;
  handsFreeRecognizer.interimResults = true;

  let interim = "";
  handsFreeRecognizer.onstart = () => {
    if (!suppressRecognizer) handsFreeStatus.textContent = "Listening…";
  };
  handsFreeRecognizer.onerror = (e) => {
    if (!suppressRecognizer) handsFreeStatus.textContent = `Error: ${e.error}`;
  };
  handsFreeRecognizer.onend = () => {
    if (!handsFreeActive) return;
    if (!suppressRecognizer) {
      // For non-continuous (iOS not supported anyway) or if Android drops, restart
      handsFreeStatus.textContent = "Reconnecting…";
      try { handsFreeRecognizer.start(); } catch (_) {}
    }
  };
  handsFreeRecognizer.onresult = async (event) => {
    if (suppressRecognizer) return;
    interim = "";
    let finalHeard = [];
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const res = event.results[i];
      if (res.isFinal) {
        finalHeard.push(res[0].transcript);
      } else {
        interim += res[0].transcript;
      }
    }
    if (interim) handsFreeStatus.textContent = `Listening… (${interim})`;
    if (finalHeard.length > 0) {
      const transcript = finalHeard.join(" ").trim();
      if (!transcript) return;
      renderMsg("user", transcript); // also show in chat log
      // First, see if it resolves a pending follow-up
      const handled = await resolvePendingFollowup(transcript);
      if (handled) return;
      // Route via LLM
      const state = await fillSavedGamesInState(getStateSnapshot());
      try {
        const route = await routeVoiceCommand(transcript, state);
        await handleRoutedAction(route);
      } catch (err) {
        console.error(err);
        await speakAsync("I had trouble understanding that. Please try again.");
      }
    }
  };

  try { handsFreeRecognizer.start(); } catch (_) {}
  // Greeting
  (async () => {
    const prompt =
      activeGameData
        ? `Hands-free mode is on. You're playing ${activeGameData.name}. Ask the referee or give commands like summarize rules, save rules, or select another game.`
        : "Hands-free mode is on. Dictate your rules, then say summarize rules, and save rules as followed by a game name.";
    await speakAsync(prompt);
  })();
}
function stopHandsFree() {
  handsFreeActive = false;
  if (handsFreeRecognizer) {
    try { handsFreeRecognizer.stop(); } catch (_) {}
    handsFreeRecognizer = null;
  }
  handsFreeBtn.textContent = "▶ Hands-free Mode";
  handsFreeStatus.textContent = "Idle";
  pendingFollowup = null;
}

// Export/Import
async function exportAll() {
  const all = await listAllGames();
  const blob = new Blob([JSON.stringify(all, null, 2)], {
    type: "application/json",
  });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "game_rules_export.json";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
async function importFromFile(file) {
  try {
    const text = await file.text();
    const arr = JSON.parse(text);
    if (!Array.isArray(arr)) throw new Error("Invalid file");
    for (const entry of arr) {
      if (!entry?.id || !entry?.data) continue;
      if (!String(entry.id).startsWith(GAMES_KEY_PREFIX)) continue;
      await set(entry.id, {
        ...entry.data,
        updatedAt: Date.now(),
      });
    }
    await refreshGamesList();
    renderMsg("bot", "Import complete.");
  } catch (e) {
    console.error(e);
    alert("Failed to import file.");
  }
}

// Wire up events
summarizeBtn.addEventListener("click", summarizeRules);
clearRulesBtn.addEventListener("click", () => {
  rulesInputEl.value = "";
});
gamesSelect.addEventListener("change", (e) => setActiveGame(e.target.value));
deleteGameBtn.addEventListener("click", deleteActiveGame);

sendBtn.addEventListener("click", async () => {
  primeAudio();
  const txt = chatInputEl.value.trim();
  chatInputEl.value = "";
  await sendChat(txt);
});
chatInputEl.addEventListener("keydown", async (e) => {
  // On mobile, Enter inserts newline; use Ctrl/Cmd+Enter to send as before
  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
    const txt = chatInputEl.value.trim();
    chatInputEl.value = "";
    await sendChat(txt);
  }
});

// Quick command chips (mobile friendly)
quickCommands.addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-cmd]");
  if (!btn) return;
  const cmd = btn.dataset.cmd;
  if (cmd === "stop") {
    stopHandsFree();
    await speakAsync("Hands-free mode stopped.");
    return;
  }
  const mapToIntent = {
    help: "help",
    summarize_rules: "summarize_rules",
    save_rules: "save_rules",
    export: "export",
  };
  const intent = mapToIntent[cmd];
  if (intent) {
    const state = await fillSavedGamesInState(getStateSnapshot());
    await handleRoutedAction({ intent, slots: {}, say: "" }, state);
  }
});

// Mic buttons
let stopRulesMic = null;
micRulesBtn.addEventListener("click", () => {
  primeAudio();
  if (!hasSpeechRecognition) {
    alert("Speech recognition is not supported in this browser.");
    return;
  }
  if (stopRulesMic) {
    stopRulesMic();
    stopRulesMic = null;
    micRulesStatus.textContent = "Idle";
    micRulesBtn.textContent = "🎤 Speak Rules";
    return;
  }
  stopRulesMic = startContinuousDictation(rulesInputEl, micRulesStatus);
  if (stopRulesMic) {
    micRulesBtn.textContent = "⏹ Stop";
  }
});

let stopChatMic = null;
micChatBtn.addEventListener("click", () => {
  primeAudio();
  if (!hasSpeechRecognition) {
    alert("Speech recognition is not supported in this browser.");
    return;
  }
  if (stopChatMic) {
    stopChatMic();
    stopChatMic = null;
    micChatStatus.textContent = "Idle";
    micChatBtn.textContent = "🎤 Ask by Voice";
    return;
  }
  stopChatMic = startContinuousDictation(chatInputEl, micChatStatus);
  if (stopChatMic) {
    micChatBtn.textContent = "⏹ Stop";
  }
});

exportBtn.addEventListener("click", exportAll);
importInput.addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  if (file) {
    await importFromFile(file);
    importInput.value = "";
  }
});

// Hands-free button
handsFreeBtn.addEventListener("click", () => {
  primeAudio();
  if (handsFreeActive) {
    stopHandsFree();
  } else {
    startHandsFree();
  }
});

// Push-to-talk bindings (mobile)
function bindPTT() {
  if (!hasSpeechRecognition) return;
  if (!pttBtn) return;
  const startPTT = () => {
    primeAudio();
    if (pttActive) return;
    pttActive = true;
    if (!pttRecognizer) pttRecognizer = createPTTRecognizer();
    try { pttRecognizer.start(); } catch (_) {}
  };
  const stopPTT = () => {
    if (!pttActive) return;
    pttActive = false;
    try { pttRecognizer.stop(); } catch (_) {}
    pttBtn.classList.remove("recording");
  };
  // Mouse + touch (passive false so we can preventDefault to avoid long-press menus)
  pttBtn.addEventListener("mousedown", (e) => { e.preventDefault(); startPTT(); });
  pttBtn.addEventListener("mouseup", (e) => { e.preventDefault(); stopPTT(); });
  pttBtn.addEventListener("mouseleave", (e) => { e.preventDefault(); stopPTT(); });
  pttBtn.addEventListener("touchstart", (e) => { e.preventDefault(); startPTT(); }, { passive: false });
  pttBtn.addEventListener("touchend", (e) => { e.preventDefault(); stopPTT(); }, { passive: false });
  pttBtn.addEventListener("touchcancel", (e) => { e.preventDefault(); stopPTT(); }, { passive: false });
}

// Initialize
(async function init() {
  // Show support banner and PTT where appropriate
  if (!hasSpeechRecognition) {
    srSupportText.textContent = isIOS
      ? "iOS Safari does not provide speech recognition. You can still use text chat and voice replies."
      : "This browser does not provide speech recognition. You can still use text chat and voice replies.";
    srSupportBanner.classList.remove("hidden");
  } else if (isMobile) {
    // Mobile has SR: show PTT option (more reliable for mobile)
    pttRow.classList.remove("hidden");
    bindPTT();
  }

  await refreshGamesList();
  // Autoselect last game on load handled in refreshGamesList
  renderMsg(
    "bot",
    "Welcome! Describe a game's rules on the left, then click Summarize & Validate to create a structured rulebook. Save it, select it, and ask me anything as your coach/referee."
  );
})();