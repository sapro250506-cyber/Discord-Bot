// storage.js
const fs = require("fs");
const path = require("path");

const FILE = path.join(__dirname, "state.json");

function loadState() {
  try {
    if (!fs.existsSync(FILE)) return {};
    const raw = fs.readFileSync(FILE, "utf8");
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function saveState(state) {
  fs.writeFileSync(FILE, JSON.stringify(state, null, 2), "utf8");
}

module.exports = { loadState, saveState };
