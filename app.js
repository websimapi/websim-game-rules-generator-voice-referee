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

// Conversation state
let conversationHistory = []; // [{ role, content }]
let activeGameId = null;
let activeGameData = null;

// Web Speech API setup (SpeechRecognition)
const SpeechRecognition =
  window.SpeechRecognition || window.webkitSpeechRecognition;
const hasSpeechRecognition = !!SpeechRecognition;

// TTS helper
function speak(text) {
  if (!ttsToggle.checked) return;
  if (!("speechSynthesis" in window)) return;
  // Cancel any ongoing speech
  window.speechSynthesis.cancel();
  const utter = new SpeechSynthesisUtterance(text);
  // Use device default voice; users can change in system settings
  utter.rate = 1.0;
  utter.pitch = 1.0;
  window.speechSynthesis.speak(utter);
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
      // auto-restart for continuous capture
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

  rec.start();

  return () => {
    listening = false;
    try {
      rec.stop();
    } catch (_) {}
  };
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
  const txt = chatInputEl.value.trim();
  chatInputEl.value = "";
  await sendChat(txt);
});
chatInputEl.addEventListener("keydown", async (e) => {
  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
    const txt = chatInputEl.value.trim();
    chatInputEl.value = "";
    await sendChat(txt);
  }
});

// Mic buttons
let stopRulesMic = null;
micRulesBtn.addEventListener("click", () => {
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

// Initialize
(async function init() {
  await refreshGamesList();
  // Autoselect last game on load handled in refreshGamesList
  renderMsg(
    "bot",
    "Welcome! Describe a game's rules on the left, then click Summarize & Validate to create a structured rulebook. Save it, select it, and ask me anything as your coach/referee."
  );
})();

