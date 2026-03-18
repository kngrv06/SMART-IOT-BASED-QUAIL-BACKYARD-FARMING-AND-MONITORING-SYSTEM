import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js";
import { 
    getAuth, 
    signInWithEmailAndPassword, 
    createUserWithEmailAndPassword, 
    onAuthStateChanged, 
    signOut 
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";

// Firebase Configuration
const firebaseConfig = {
    apiKey: "AIzaSyAiWKZaly3dPspMIzfgy7q9pLYEHBTxBAI",
    authDomain: "smart-quial.firebaseapp.com",
    databaseURL: "https://smart-quial-default-rtdb.asia-southeast1.firebasedatabase.app",
    projectId: "smart-quial",
    storageBucket: "smart-quial.firebasestorage.app",
    messagingSenderId: "144709205906",
    appId: "1:144709205906:web:94caf405b3568b03c74b4b"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);

// Blynk Configuration
const blynkConfig = {
    baseUrl: '/api/blynk', // Use backend proxy
    pollInterval: 5000, 
};

// State Management
let isAuthModeLogin = true;
let currentUser = null;
let pollTimer = null;
let farmState = {
    v0: 0, v1: 0, v2: 0, v3: 0,
    v10: 0, v11: 0, v12: 0, v13: 0,
    v20: 3, v21: 420, // Default 7:00 AM
    v22: 20, v23: 480, // Default 8:00 AM
    v24: 1080, v25: 360, // Default 18:00 to 06:00
    isOnline: false
};

// Mock History Data
let farmHistory = JSON.parse(localStorage.getItem('farm_history')) || [
    { date: '2026-03-17', avgTemp: 24.5, avgAmmonia: 4.2, eggs: 42 },
    { date: '2026-03-16', avgTemp: 23.8, avgAmmonia: 3.8, eggs: 38 },
    { date: '2026-03-15', avgTemp: 25.1, avgAmmonia: 5.1, eggs: 45 }
];

// UI Elements
const authOverlay = document.getElementById('auth-overlay');
const dashboard = document.getElementById('dashboard');
const authForm = document.getElementById('auth-form');
const authEmail = document.getElementById('auth-email');
const authPassword = document.getElementById('auth-password');
const authSubmitBtn = document.getElementById('auth-submit-btn');
const toggleAuthModeBtn = document.getElementById('toggle-auth-mode');
const authSubtitle = document.getElementById('auth-subtitle');
const logoutBtn = document.getElementById('logout-btn');
const userDisplayName = document.getElementById('user-display-name');
const terminalLog = document.getElementById('terminal-log');
const currentTimeDisplay = document.getElementById('current-time');
const currentDateDisplay = document.getElementById('current-date');
const enableNotifsBtn = document.getElementById('enable-notifs');

// --- Authentication Logic ---

onAuthStateChanged(auth, (user) => {
    if (user) {
        currentUser = user;
        userDisplayName.textContent = user.email.split('@')[0];
        authOverlay.classList.add('hidden');
        showDashboard();
    } else {
        currentUser = null;
        showAuthOverlay();
        stopPolling();
    }
});

async function handleAuthSubmit(e) {
    e.preventDefault();
    const email = authEmail.value;
    const password = authPassword.value;

    try {
        if (isAuthModeLogin) {
            await signInWithEmailAndPassword(auth, email, password);
            addLog("Logged in successfully.");
        } else {
            await createUserWithEmailAndPassword(auth, email, password);
            addLog("Account created and logged in.");
        }
    } catch (error) {
        console.error("Auth error:", error);
        alert(error.message);
        addLog(`Auth Error: ${error.message}`);
    }
}

function toggleAuthMode() {
    isAuthModeLogin = !isAuthModeLogin;
    authSubtitle.textContent = isAuthModeLogin ? "Sign in to your dashboard" : "Create a new account";
    authSubmitBtn.textContent = isAuthModeLogin ? "Sign In" : "Register";
    toggleAuthModeBtn.textContent = isAuthModeLogin ? "Don't have an account? Register" : "Already have an account? Login";
}

async function handleLogout() {
    try {
        await signOut(auth);
        location.reload();
    } catch (error) {
        addLog(`Logout Error: ${error.message}`);
    }
}

// --- UI Navigation ---

function showAuthOverlay() {
    authOverlay.classList.remove('hidden');
    dashboard.classList.add('hidden');
}

function showDashboard() {
    authOverlay.classList.add('hidden');
    dashboard.classList.remove('hidden');
    
    // Show Blynk Template Info if provided
    const templateId = process.env.VITE_BLYNK_TEMPLATE_ID;
    const templateName = process.env.VITE_BLYNK_TEMPLATE_NAME;
    const authToken = process.env.BLYNK_AUTH_TOKEN;

    if (templateId && templateName) {
        document.getElementById('template-info').classList.remove('hidden');
        document.getElementById('template-id').textContent = templateId;
        document.getElementById('template-name').textContent = templateName;
    }

    // Show a warning if keys are missing
    if (!templateId || !templateName || !authToken || authToken === 'YOUR_BLYNK_AUTH_TOKEN') {
        addLog("CRITICAL: Blynk API Keys are missing! Check your Secrets/Environment Variables.", "error");
        const warningEl = document.createElement('div');
        warningEl.className = 'bg-red-500 text-white p-4 rounded-xl mb-6 text-center animate-pulse';
        warningEl.innerHTML = `
            <p class='font-bold'>⚠️ Missing Blynk Configuration</p>
            <p class='text-xs'>Please add <b>BLYNK_AUTH_TOKEN</b>, <b>VITE_BLYNK_TEMPLATE_ID</b>, and <b>VITE_BLYNK_TEMPLATE_NAME</b> to your environment variables.</p>
        `;
        dashboard.prepend(warningEl);
    }

    renderHistory();
    startPolling();
    checkNotificationPermission();
}

// --- Blynk API Integration ---

async function fetchBlynkData() {
    // We fetch pins in a way that handles potential missing pins in the template
    const sensorPins = ['V0', 'V1', 'V2', 'V3'];
    const actuatorPins = ['V10', 'V11', 'V12', 'V13', 'V4'];
    const schedulePins = ['V20', 'V21', 'V22', 'V23', 'V24', 'V25'];
    const allPins = [...sensorPins, ...actuatorPins, ...schedulePins];

    try {
        // Try batch fetch first via proxy (token is handled by backend)
        const url = `${blynkConfig.baseUrl}/get?${allPins.join('&')}`;
        const response = await fetch(url);
        
        if (response.ok) {
            const data = await response.json();
            updateState(data);
            updateStatus(true);
        } else if (response.status === 400) {
            // If batch fails (likely due to missing pins in template), fetch individually
            addLog("Batch fetch failed, attempting individual pin updates...", "warn");
            for (const pin of allPins) {
                try {
                    const pUrl = `${blynkConfig.baseUrl}/get?${pin}`;
                    const pRes = await fetch(pUrl);
                    if (pRes.ok) {
                        const val = await pRes.text();
                        const update = {};
                        update[pin] = val;
                        updateState(update);
                    }
                } catch (e) {
                    // Ignore individual pin errors
                }
            }
            updateStatus(true);
        } else {
            throw new Error(`Server returned ${response.status}`);
        }
    } catch (error) {
        console.error("Fetch error:", error);
        updateStatus(false);
        // Only log to terminal if it's a new error to avoid spam
        if (farmState.isOnline) {
            addLog(`Blynk Connection Error: ${error.message}`, "error");
        }
    }
}

async function updateBlynkPin(pin, value) {
    const url = `${blynkConfig.baseUrl}/update?${pin}=${value}`;
    try {
        const response = await fetch(url);
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(errorText || "Update failed");
        }
        addLog(`Updated ${pin} to ${value}`);
        farmState[pin.toLowerCase()] = value;
        renderActuators();
        return true;
    } catch (error) {
        addLog(`Update Error (${pin}): ${error.message}`, "error");
        return false;
    }
}

async function saveSettings() {
    const feedTime = document.getElementById('feed-time').value;
    const feedDur = document.getElementById('feed-duration').value;
    const cleanTime = document.getElementById('cleaner-time').value;
    const cleanDur = document.getElementById('cleaner-duration').value;
    const lightStart = document.getElementById('light-start').value;
    const lightEnd = document.getElementById('light-end').value;

    const timeToMins = (t) => {
        if (!t) return 0;
        const [h, m] = t.split(':').map(Number);
        return h * 60 + m;
    };

    addLog("Saving settings to ESP32...");
    
    const settings = {
        'V20': feedDur,
        'V21': timeToMins(feedTime),
        'V22': cleanDur,
        'V23': timeToMins(cleanTime),
        'V24': timeToMins(lightStart),
        'V25': timeToMins(lightEnd)
    };

    let successCount = 0;
    let failCount = 0;

    for (const [pin, val] of Object.entries(settings)) {
        try {
            const url = `${blynkConfig.baseUrl}/update?${pin}=${val}`;
            const response = await fetch(url);
            if (!response.ok) {
                const errText = await response.text();
                if (errText.includes("doesn't exist")) {
                    console.warn(`Pin ${pin} not found in Blynk template.`);
                } else {
                    throw new Error(errText);
                }
                failCount++;
            } else {
                successCount++;
            }
        } catch (e) {
            console.error(`Error saving ${pin}:`, e);
            failCount++;
        }
    }

    if (successCount > 0) {
        addLog(`Settings saved (${successCount} pins updated).`);
        
        // Update local state
        farmState.v20 = parseInt(feedDur);
        farmState.v21 = timeToMins(feedTime);
        farmState.v22 = parseInt(cleanDur);
        farmState.v23 = timeToMins(cleanTime);
        farmState.v24 = timeToMins(lightStart);
        farmState.v25 = timeToMins(lightEnd);

        if (failCount > 0) {
            addLog(`${failCount} pins missing in Blynk template.`, "warn");
        }
    } else {
        addLog("Failed to save settings. Check Auth Token.", "error");
    }
}

// --- Dashboard Logic ---

function updateState(data) {
    Object.keys(data).forEach(pin => {
        const val = parseFloat(data[pin]);
        const pinKey = pin.toLowerCase();
        
        if (farmState[pinKey] !== val) {
            const oldVal = farmState[pinKey];
            farmState[pinKey] = val;
            
            if (['v10', 'v11', 'v12', 'v13', 'v4'].includes(pinKey)) {
                const name = getActuatorName(pinKey);
                addLog(`${name} turned ${val ? 'ON' : 'OFF'}`);
            }

            runAutomationLogic(pinKey, val);
        }
    });

    renderSensors();
    renderActuators();
    updateScheduleUI();
}

function runAutomationLogic(pin, val) {
    // Fan ON if temp > 27°C, OFF ≤ 25°C
    if (pin === 'v0') {
        if (val > 27 && farmState.v10 === 0) {
            addLog('Auto-trigger: Temperature high (>27°C). Turning Fan ON.');
            updateBlynkPin('V10', 1);
            sendNotification('High Temperature Alert', `Temp is ${val}°C. Fan activated.`);
        } else if (val <= 25 && farmState.v10 === 1) {
            addLog('Auto-trigger: Temperature stabilized (≤25°C). Turning Fan OFF.');
            updateBlynkPin('V10', 0);
        }
    }

    // Heater ON ≤ 18°C, OFF ≥ 25°C
    if (pin === 'v0') {
        if (val <= 18 && farmState.v11 === 0) {
            addLog('Auto-trigger: Temperature low (≤18°C). Turning Heater ON.');
            updateBlynkPin('V11', 1);
            sendNotification('Low Temperature Alert', `Temp is ${val}°C. Heater activated.`);
        } else if (val >= 25 && farmState.v11 === 1) {
            addLog('Auto-trigger: Temperature stabilized (≥25°C). Turning Heater OFF.');
            updateBlynkPin('V11', 0);
        }
    }

    // Stool Cleaner auto if ammonia ≥ 10 ppm
    if (pin === 'v2') {
        if (val >= 10 && farmState.v13 === 0) {
            addLog('Auto-trigger: High Ammonia (≥10ppm). Starting Stool Cleaner.');
            updateBlynkPin('V13', 1);
            sendNotification('Ammonia Warning', `Ammonia level at ${val}ppm. Cleaning started.`);
            
            setTimeout(() => {
                addLog('Stool Cleaner cycle complete (20s). Turning OFF.');
                updateBlynkPin('V13', 0);
            }, 20000);
        }
    }
}

function renderSensors() {
    // Temp Note
    const tempNote = document.getElementById('note-v0');
    if (farmState.v0 >= 18 && farmState.v0 <= 27) {
        setNote(tempNote, 'Optimal', 'bg-emerald-100 text-emerald-600');
    } else {
        setNote(tempNote, 'Critical', 'bg-red-100 text-red-600');
    }

    // Humidity Note
    const humNote = document.getElementById('note-v1');
    if (farmState.v1 >= 40 && farmState.v1 <= 70) {
        setNote(humNote, 'Optimal', 'bg-emerald-100 text-emerald-600');
    } else {
        setNote(humNote, 'Critical', 'bg-red-100 text-red-600');
    }

    // Ammonia Note
    const ammNote = document.getElementById('note-v2');
    if (farmState.v2 < 10) {
        setNote(ammNote, 'Optimal', 'bg-emerald-100 text-emerald-600');
    } else {
        setNote(ammNote, 'Critical', 'bg-red-100 text-red-600');
    }

    // Feed Note
    const feedNote = document.getElementById('note-v3');
    if (farmState.v3 > 20) {
        setNote(feedNote, 'Optimal', 'bg-emerald-100 text-emerald-600');
    } else {
        setNote(feedNote, 'Critical', 'bg-red-100 text-red-600');
    }

    updateSensorUI('v0', farmState.v0, 50);
    updateSensorUI('v1', farmState.v1, 100);
    updateSensorUI('v2', farmState.v2, 20);
    updateSensorUI('v3', farmState.v3, 100);
}

function setNote(el, text, classes) {
    if (!el) return;
    el.textContent = text;
    el.className = `text-[10px] font-bold px-2 py-1 rounded-full uppercase tracking-widest ${classes}`;
}

function updateSensorUI(id, val, max) {
    const el = document.getElementById(`val-${id}`);
    const bar = document.getElementById(`bar-${id}`);
    if (el) el.innerText = val;
    if (bar) {
        const pct = Math.min((val / max) * 100, 100);
        bar.style.width = `${pct}%`;
    }
}

function renderActuators() {
    ['v10', 'v11', 'v12', 'v13', 'v4'].forEach(pin => {
        const btn = document.getElementById(`btn-${pin}`);
        const dot = btn.querySelector('.dot');
        if (farmState[pin] === 1) {
            btn.classList.remove('bg-stone-300');
            btn.classList.add('bg-emerald-500');
            dot.classList.add('translate-x-6');
        } else {
            btn.classList.add('bg-stone-300');
            btn.classList.remove('bg-emerald-500');
            dot.classList.remove('translate-x-6');
        }
    });
}

function updateScheduleUI() {
    const minsToTime = (m) => {
        const h = Math.floor(m / 60).toString().padStart(2, '0');
        const min = (m % 60).toString().padStart(2, '0');
        return `${h}:${min}`;
    };

    const setIfNoFocus = (id, val) => {
        const el = document.getElementById(id);
        if (el && !el.matches(':focus')) el.value = val;
    };

    setIfNoFocus('feed-time', minsToTime(farmState.v21));
    setIfNoFocus('feed-duration', farmState.v20);
    setIfNoFocus('cleaner-time', minsToTime(farmState.v23));
    setIfNoFocus('cleaner-duration', farmState.v22);
    setIfNoFocus('light-start', minsToTime(farmState.v24));
    setIfNoFocus('light-end', minsToTime(farmState.v25));
}

function updateStatus(online) {
    const dot = document.getElementById('status-dot');
    const text = document.getElementById('status-text');
    if (online) {
        dot.classList.replace('bg-stone-300', 'bg-emerald-500');
        dot.classList.remove('bg-red-500');
        text.textContent = "Online";
        text.classList.replace('text-stone-500', 'text-emerald-600');
        text.classList.remove('text-red-500');
        if (!farmState.isOnline) {
            addLog("ESP32 is ONLINE.");
            sendNotification('System Status', 'Quail Farm ESP32 is now online.');
        }
    } else {
        dot.classList.replace('bg-emerald-500', 'bg-red-500');
        text.textContent = "Offline / Error";
        text.classList.replace('text-emerald-600', 'text-red-500');
        if (farmState.isOnline) {
            addLog("ESP32 is OFFLINE!", "error");
            sendNotification('System Status', 'ALERT: Quail Farm ESP32 went offline.');
        }
    }
    farmState.isOnline = online;
}

function addLog(message, type = 'info') {
    const time = new Date().toLocaleTimeString([], { hour12: false });
    const entry = document.createElement('div');
    let colorClass = 'text-stone-400';
    if (type === 'error') colorClass = 'text-red-400';
    entry.innerHTML = `<span class="text-stone-600">[${time}]</span> <span class="${colorClass}">${message}</span>`;
    terminalLog.appendChild(entry);
    terminalLog.scrollTop = terminalLog.scrollHeight;
}

function renderHistory() {
    const tbody = document.getElementById('history-table');
    tbody.innerHTML = farmHistory.map(row => `
        <tr class="border-b border-stone-50 hover:bg-stone-50 transition-colors">
            <td class="py-3 font-medium">${row.date}</td>
            <td class="py-3">${row.avgTemp}°C</td>
            <td class="py-3">${row.avgAmmonia}ppm</td>
            <td class="py-3 font-bold text-emerald-600">${row.eggs}</td>
        </tr>
    `).join('');
}

function logEggs() {
    const count = prompt('Enter number of eggs collected today:');
    if (count !== null && !isNaN(count)) {
        const today = new Date().toISOString().split('T')[0];
        const existing = farmHistory.find(h => h.date === today);
        if (existing) {
            existing.eggs = parseInt(count);
        } else {
            farmHistory.unshift({
                date: today,
                avgTemp: farmState.v0 || 25,
                avgAmmonia: farmState.v2 || 2,
                eggs: parseInt(count)
            });
        }
        localStorage.setItem('farm_history', JSON.stringify(farmHistory));
        renderHistory();
        addLog(`Logged ${count} eggs for ${today}.`);
    }
}

function sendNotification(title, body) {
    if ("Notification" in window && Notification.permission === "granted") {
        new Notification(title, { body });
    }
}

function checkNotificationPermission() {
    if (!("Notification" in window)) return;
    if (Notification.permission === "default") {
        enableNotifsBtn.classList.remove('hidden');
    } else {
        enableNotifsBtn.classList.add('hidden');
    }
}

function getActuatorName(pin) {
    const names = { v10: 'Fan', v11: 'Heater', v12: 'Light', v13: 'Cleaner', v4: 'Feed' };
    return names[pin] || pin.toUpperCase();
}

function startPolling() {
    if (pollTimer) clearInterval(pollTimer);
    fetchBlynkData();
    pollTimer = setInterval(fetchBlynkData, blynkConfig.pollInterval);
}

function stopPolling() {
    if (pollTimer) clearInterval(pollTimer);
}

// --- Event Listeners ---

authForm.addEventListener('submit', handleAuthSubmit);
toggleAuthModeBtn.addEventListener('click', toggleAuthMode);
logoutBtn.addEventListener('click', handleLogout);

['v10', 'v11', 'v12', 'v13', 'v4'].forEach(pin => {
    document.getElementById(`btn-${pin}`).addEventListener('click', function() {
        const isActive = farmState[pin] === 1;
        const targetVal = isActive ? 0 : 1;
        updateBlynkPin(pin.toUpperCase(), targetVal);
        
        // For V4 (Feed), auto-off after 3 seconds in the UI for better feedback
        if (pin === 'v4' && targetVal === 1) {
            addLog("Feeding started...");
            setTimeout(() => {
                if (farmState.v4 === 1) {
                    updateBlynkPin('V4', 0);
                }
            }, 3000);
        }
    });
});

document.getElementById('save-settings').addEventListener('click', saveSettings);

document.getElementById('add-egg-btn').addEventListener('click', logEggs);
document.getElementById('clear-log').addEventListener('click', () => {
    terminalLog.innerHTML = '';
    addLog("Terminal cleared.");
});

enableNotifsBtn.addEventListener('click', () => {
    Notification.requestPermission().then(permission => {
        if (permission === "granted") {
            enableNotifsBtn.classList.add('hidden');
            addLog("Notifications enabled.");
        }
    });
});

setInterval(() => {
    const now = new Date();
    currentTimeDisplay.textContent = now.toLocaleTimeString([], { hour12: false });
    currentDateDisplay.textContent = now.toLocaleDateString('en-US', { 
        weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' 
    });
}, 1000);
