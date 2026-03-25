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
    baseUrl: '/api/blynk',
    pollInterval: 5000, 
};

// Calibration Settings (Adjust these based on your actual sensor)
const CALIBRATION = {
    V3_EMPTY: 0,  // Ang value na ito ay magiging 0% (Wala pang laman)
    V3_FULL: 100  // Default 100, i-adjust kung kailangan
};

// State Management
let isAuthModeLogin = true;
let currentUser = null;
let pollTimer = null;
let hourlyTimer = null;
let tempChart = null;
let humChart = null;
let ammChart = null;
let eggsChart = null;

// Track manual overrides to prevent polling from flickering the UI
let manualOverrides = {};

let farmState = {
    v0: 0, v1: 0, v2: 0, v3: 0,
    v10: 0, v11: 0, v12: 0, v13: 0,
    v20: 3, v21: 420, // Default 7:00 AM
    v22: 20, v23: 480, // Default 8:00 AM
    v24: 1080, v25: 360, // Default 18:00 to 06:00
    isOnline: false,
    isAutoMode: localStorage.getItem('auto_mode') === 'true'
};

// 24-hour cooldown for manual feeding
let lastManualFeedTime = parseInt(localStorage.getItem('last_manual_feed_time')) || 0;
const COOLDOWN_24H = 24 * 60 * 60 * 1000; // 24 hours in milliseconds

// Hourly Data for Graph
let hourlyData = JSON.parse(localStorage.getItem('hourly_data')) || [];

async function syncHistoryWithServer() {
    try {
        const response = await fetch('/api/history');
        if (response.ok) {
            const serverLogs = await response.json();
            if (serverLogs.length > 0) {
                // Merge server logs with local data (server logs are more reliable for sensors)
                // We'll use a Map to handle unique timestamps
                const merged = new Map();
                
                // First, put local data in the map
                hourlyData.forEach(d => merged.set(d.time, d));
                
                // Then, overwrite with server data (which is more reliable for 24h trend)
                serverLogs.forEach(d => {
                    const existing = merged.get(d.time);
                    if (existing) {
                        // Keep local eggs if they exist
                        d.eggs = existing.eggs || 0;
                    }
                    merged.set(d.time, d);
                });

                // Sort by timestamp
                hourlyData = Array.from(merged.values()).sort((a, b) => a.timestamp - b.timestamp);
                
                // Keep only last 24 entries
                if (hourlyData.length > 24) {
                    hourlyData = hourlyData.slice(-24);
                }
                
                localStorage.setItem('hourly_data', JSON.stringify(hourlyData));
                updateChart();
            }
        }
    } catch (error) {
        console.error("Failed to sync history:", error);
    }
}

// Mock History Data
let farmHistory = JSON.parse(localStorage.getItem('farm_history')) || [
    { date: '2026-03-15', avgTemp: 25.1, avgHum: 62.4, avgAmmonia: 850, eggs: 45 },
    { date: '2026-03-16', avgTemp: 23.8, avgHum: 68.1, avgAmmonia: 720, eggs: 38 },
    { date: '2026-03-17', avgTemp: 24.5, avgHum: 65.2, avgAmmonia: 780, eggs: 42 }
];

// Ensure history is sorted by date for the chart
farmHistory.sort((a, b) => new Date(a.date) - new Date(b.date));

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
const feedCooldownTimer = document.getElementById('feed-cooldown-timer');
const profileTrigger = document.getElementById('profile-trigger');
const profileMenu = document.getElementById('profile-menu');
const demoModeBtn = document.getElementById('demo-mode-btn');
const demoStatus = document.getElementById('demo-status');
const autoModeToggle = document.getElementById('auto-mode-toggle');
const editEggBtn = document.getElementById('edit-egg-btn');
const resetHistoryBtn = document.getElementById('reset-history-btn');
const confirmModal = document.getElementById('confirm-modal');
const confirmCancel = document.getElementById('confirm-cancel');
const confirmProceed = document.getElementById('confirm-proceed');
const confirmMessage = document.getElementById('confirm-message');

let confirmCallback = null;

function showConfirm(message, onConfirm) {
    confirmMessage.textContent = message;
    confirmModal.classList.remove('hidden');
    confirmCallback = onConfirm;
}

function hideConfirm() {
    confirmModal.classList.add('hidden');
    confirmCallback = null;
}

confirmCancel.addEventListener('click', hideConfirm);
confirmProceed.addEventListener('click', () => {
    if (confirmCallback) confirmCallback();
    hideConfirm();
});

resetHistoryBtn.addEventListener('click', () => {
    showConfirm("Are you sure you want to reset the Daily Averages? This will clear all logged daily records.", () => {
        // Clear local storage for daily history only
        localStorage.removeItem('farm_history');
        
        // Reset local variable for daily history
        // We'll keep some mock data or just empty it? 
        // Usually reset means empty, but the initial state had mock data.
        // Let's set it to empty so the user sees it's actually reset.
        farmHistory = [];
        
        // Update UI
        renderHistory();
        addLog("Daily averages have been reset.");
    });
});

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
    renderHistory();
    initChart();
    startPolling();
    startHourlyLogging();
    syncHistoryWithServer();
    checkNotificationPermission();
    updateAutoModeUI();
}

// --- Blynk API Integration ---

async function fetchBlynkData() {
    // We fetch pins in a way that handles potential missing pins in the template
    const sensorPins = ['V0', 'V1', 'V2', 'V3'];
    const actuatorPins = ['V10', 'V11', 'V12', 'V13', 'V4', 'V5'];
    const schedulePins = ['V20', 'V21', 'V22', 'V23', 'V24', 'V25'];
    const allPins = [...sensorPins, ...actuatorPins, ...schedulePins];

    try {
        // Try batch fetch first
        const url = `${blynkConfig.baseUrl}/get?${allPins.join('&')}`;
        const response = await fetch(url);
        
        if (response.ok) {
            const data = await response.json();
            updateState(data);
            updateStatus(true);
        } else {
            // If batch fails (likely due to missing pins or 400 error), fetch individually
            const errorText = await response.text();
            console.warn("Batch fetch failed, attempting individual pin updates:", errorText);
            
            let successAny = false;
            for (const pin of allPins) {
                try {
                    const pUrl = `${blynkConfig.baseUrl}/get?${pin}`;
                    const pRes = await fetch(pUrl);
                    if (pRes.ok) {
                        const val = await pRes.text();
                        const update = {};
                        update[pin] = val;
                        updateState(update);
                        successAny = true;
                    }
                } catch (e) {
                    // Skip pins that don't exist
                }
            }
            updateStatus(successAny);
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
    const pinKey = pin.toLowerCase();
    
    // Set manual override flag to prevent polling from flickering the UI
    manualOverrides[pinKey] = Date.now() + 10000; // Ignore polling for 10 seconds

    const url = `${blynkConfig.baseUrl}/update?${pin}=${value}`;
    try {
        const response = await fetch(url);
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(errorText || "Update failed");
        }
        addLog(`Updated ${pin} to ${value}`);
        farmState[pinKey] = value;
        renderActuators();
        return true;
    } catch (error) {
        addLog(`Update Error (${pin}): ${error.message}`, "error");
        delete manualOverrides[pinKey];
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
        farmState.v20 = parseFloat(feedDur);
        farmState.v21 = timeToMins(feedTime);
        farmState.v22 = parseFloat(cleanDur);
        farmState.v23 = timeToMins(cleanTime);
        farmState.v24 = timeToMins(lightStart);
        farmState.v25 = timeToMins(lightEnd);

        if (failCount > 0) {
            addLog(`${failCount} pins missing in Blynk template.`, "warn");
        }
    } else {
        addLog("Failed to save settings. Check backend configuration.", "error");
    }
}

// --- Dashboard Logic ---

function updateState(data) {
    const now = Date.now();
    Object.keys(data).forEach(pin => {
        const val = parseFloat(data[pin]);
        const pinKey = pin.toLowerCase();
        
        // Skip if this pin is currently under manual override
        if (manualOverrides[pinKey] && now < manualOverrides[pinKey]) {
            return;
        }

        if (farmState[pinKey] !== val) {
            const oldVal = farmState[pinKey];
            farmState[pinKey] = val;
            
            if (pinKey === 'v5') {
                const isAuto = val === 1;
                if (farmState.isAutoMode !== isAuto) {
                    farmState.isAutoMode = isAuto;
                    localStorage.setItem('auto_mode', isAuto);
                    updateAutoModeUI();
                    renderActuators();
                    addLog(`Auto Mode synced from server: ${isAuto ? 'ON' : 'OFF'}`);
                }
            }

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
    // Automation logic only runs if Auto Mode is ON
    if (!farmState.isAutoMode) return;

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

    // Stool Cleaner auto if Ammonia Raw ≥ 1500
    if (pin === 'v2') {
        if (val >= 1500 && farmState.v13 === 0) {
            addLog('Auto-trigger: High Ammonia Raw (≥1500). Starting Stool Cleaner.');
            updateBlynkPin('V13', 1);
            sendNotification('Ammonia Warning', `Raw level at ${val}. Cleaning started.`);
            
            setTimeout(() => {
                addLog('Stool Cleaner cycle complete (20s). Turning OFF.');
                updateBlynkPin('V13', 0);
            }, 20000);
        }
    }
}

function renderSensors() {
    // Temp (V0)
    const temp = farmState.v0;
    let tempStatus = 'critical';
    if (temp >= 21 && temp <= 24) tempStatus = 'optimal';
    else if ((temp >= 18 && temp < 21) || (temp > 24 && temp <= 27)) tempStatus = 'warning';
    updateCardStatus('v0', tempStatus, tempStatus === 'optimal' ? 'Optimal' : tempStatus === 'warning' ? 'Warning' : 'Critical');

    // Humidity (V1)
    const hum = farmState.v1;
    let humStatus = 'critical';
    if (hum >= 40 && hum <= 70) humStatus = 'optimal';
    else if ((hum >= 35 && hum < 40) || (hum > 70 && hum <= 75)) humStatus = 'warning';
    updateCardStatus('v1', humStatus, humStatus === 'optimal' ? 'Optimal' : humStatus === 'warning' ? 'Warning' : 'Critical');

    // Ammonia Raw (V2)
    const amm = farmState.v2;
    let ammStatus = 'critical';
    if (amm < 900) ammStatus = 'optimal';
    else if (amm >= 900 && amm <= 1500) ammStatus = 'warning';
    updateCardStatus('v2', ammStatus, ammStatus === 'optimal' ? 'Optimal' : ammStatus === 'warning' ? 'Warning' : 'Critical');

    // Feed Level (V3)
    const feed = farmState.v3;
    const empty = CALIBRATION.V3_EMPTY;
    const full = CALIBRATION.V3_FULL;
    const feedPct = Math.max(0, Math.min(100, ((feed - empty) / (full - empty)) * 100));
    
    let feedStatus = 'critical';
    if (feedPct > 20) feedStatus = 'optimal';
    else if (feedPct >= 10 && feedPct <= 20) feedStatus = 'warning';
    updateCardStatus('v3', feedStatus, feedStatus === 'optimal' ? 'Optimal' : feedStatus === 'warning' ? 'Warning' : 'Critical');

    updateSensorUI('v0', farmState.v0, 50);
    updateSensorUI('v1', farmState.v1, 100);
    updateSensorUI('v2', farmState.v2, 4095);
    updateSensorUI('v3', farmState.v3, 100);
}

function updateCardStatus(pin, status, text) {
    const card = document.getElementById(`card-${pin}`);
    const note = document.getElementById(`note-${pin}`);
    const title = document.getElementById(`title-${pin}`);
    const val = document.getElementById(`val-${pin}`);
    const unit = document.getElementById(`unit-${pin}`);
    const icon = document.getElementById(`icon-${pin}`);
    const barCont = document.getElementById(`bar-cont-${pin}`);
    const legCrit = document.getElementById(`leg-${pin}-crit`);
    const legWarn = document.getElementById(`leg-${pin}-warn`);
    const legOpt = document.getElementById(`leg-${pin}-opt`);

    if (!card || !note) return;

    // Reset styles
    card.classList.remove('bg-emerald-500', 'bg-amber-500', 'bg-red-500', 'border-emerald-600', 'border-amber-600', 'border-red-600', 'text-white');
    card.classList.add('bg-white', 'border-stone-200');
    
    if (title) title.classList.replace('text-white/80', 'text-stone-500');
    if (val) val.classList.replace('text-white', 'text-stone-800');
    if (unit) unit.classList.replace('text-white/60', 'text-stone-400');
    if (barCont) barCont.classList.replace('bg-white/20', 'bg-stone-100');
    
    if (icon) {
        icon.classList.remove('bg-white/20', 'text-white');
        const defaultIconClasses = {
            'v0': ['bg-orange-50', 'text-orange-600'],
            'v1': ['bg-blue-50', 'text-blue-600'],
            'v2': ['bg-purple-50', 'text-purple-600'],
            'v3': ['bg-emerald-50', 'text-emerald-600']
        };
        const defaults = defaultIconClasses[pin] || ['bg-stone-50', 'text-stone-600'];
        icon.classList.add(...defaults);
    }

    [legCrit, legWarn, legOpt].forEach(el => {
        if (!el) return;
        el.classList.remove('bg-red-600', 'bg-amber-600', 'bg-emerald-600', 'bg-white/20', 'text-white', 'shadow-sm');
        const span = el.querySelector('span');
        if (span) span.classList.remove('text-white');
    });

    const applyStatusStyles = (bgColor, borderColor) => {
        card.classList.replace('bg-white', bgColor);
        card.classList.replace('border-stone-200', borderColor);
        card.classList.add('text-white');
        if (title) title.classList.replace('text-stone-500', 'text-white/80');
        if (val) val.classList.replace('text-stone-800', 'text-white');
        if (unit) unit.classList.replace('text-stone-400', 'text-white/60');
        if (barCont) barCont.classList.replace('bg-stone-100', 'bg-white/20');
        if (icon) {
            const defaultIconClasses = {
                'v0': ['bg-orange-50', 'text-orange-600'],
                'v1': ['bg-blue-50', 'text-blue-600'],
                'v2': ['bg-purple-50', 'text-purple-600'],
                'v3': ['bg-emerald-50', 'text-emerald-600']
            };
            icon.classList.remove(...(defaultIconClasses[pin] || []));
            icon.classList.add('bg-white/20', 'text-white');
        }
        setNote(note, text, 'bg-white/20 text-white');
    };

    if (status === 'optimal') {
        applyStatusStyles('bg-emerald-500', 'border-emerald-600');
        if (legOpt) {
            legOpt.classList.add('bg-white/20', 'text-white', 'shadow-sm');
            const span = legOpt.querySelector('span');
            if (span) span.classList.add('text-white');
        }
    } else if (status === 'warning') {
        applyStatusStyles('bg-amber-500', 'border-amber-600');
        if (legWarn) {
            legWarn.classList.add('bg-white/20', 'text-white', 'shadow-sm');
            const span = legWarn.querySelector('span');
            if (span) span.classList.add('text-white');
        }
    } else {
        applyStatusStyles('bg-red-500', 'border-red-600');
        if (legCrit) {
            legCrit.classList.add('bg-white/20', 'text-white', 'shadow-sm');
            const span = legCrit.querySelector('span');
            if (span) span.classList.add('text-white');
        }
    }
}

function setNote(el, text, classes) {
    if (!el) return;
    el.textContent = text;
    el.className = `text-[10px] font-bold px-2 py-1 rounded-full uppercase tracking-widest ${classes}`;
}

function updateSensorUI(id, val, max) {
    const el = document.getElementById(`val-${id}`);
    const bar = document.getElementById(`bar-${id}`);
    
    let displayVal = val;
    let pct = Math.min((val / max) * 100, 100);

    // Calibration logic for Feed Level (V3)
    if (id === 'v3') {
        const empty = CALIBRATION.V3_EMPTY;
        const full = CALIBRATION.V3_FULL;
        
        // Calculate percentage based on direct mapping
        // (val - empty) / (full - empty) * 100
        let calculatedPct = ((val - empty) / (full - empty)) * 100;
        
        pct = Math.max(0, Math.min(100, calculatedPct));
        displayVal = Math.round(pct);

        if (el) el.innerText = `${displayVal}%`;
    } else {
        if (el) el.innerText = displayVal;
    }
    if (bar) {
        bar.style.width = `${pct}%`;
    }
}

function renderActuators() {
    ['v10', 'v11', 'v12', 'v13', 'v4'].forEach(pin => {
        const btn = document.getElementById(`btn-${pin}`);
        const dot = btn.querySelector('.dot');
        
        if (farmState.isAutoMode) {
            btn.classList.add('opacity-50', 'cursor-not-allowed');
        } else {
            btn.classList.remove('opacity-50', 'cursor-not-allowed');
        }

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
    if (!tbody) return;
    
    // Show newest first in table
    const sortedHistory = [...farmHistory].sort((a, b) => new Date(b.date) - new Date(a.date));
    
    tbody.innerHTML = sortedHistory.map(row => `
        <tr class="border-b border-stone-50 hover:bg-stone-50 transition-colors">
            <td class="py-3 font-medium">${row.date}</td>
            <td class="py-3">${row.avgTemp.toFixed(1)}°C</td>
            <td class="py-3">${(row.avgHum || 0).toFixed(1)}%</td>
            <td class="py-3">${row.avgAmmonia.toFixed(0)}</td>
            <td class="py-3 font-bold text-emerald-600">${row.eggs}</td>
        </tr>
    `).join('');
}

function initChart() {
    const commonOptions = {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
            y: { beginAtZero: true, grid: { color: '#f5f5f4' } },
            x: { grid: { display: false } }
        }
    };

    const labels = hourlyData.map(d => d.time);

    const tempCtx = document.getElementById('tempChart');
    if (tempCtx) {
        tempChart = new Chart(tempCtx.getContext('2d'), {
            type: 'line',
            data: { labels, datasets: [{ label: 'Temp', data: hourlyData.map(d => d.temp), borderColor: '#f97316', tension: 0.4, pointRadius: 2 }] },
            options: commonOptions
        });
    }

    const humCtx = document.getElementById('humChart');
    if (humCtx) {
        humChart = new Chart(humCtx.getContext('2d'), {
            type: 'line',
            data: { labels, datasets: [{ label: 'Hum', data: hourlyData.map(d => d.hum), borderColor: '#3b82f6', tension: 0.4, pointRadius: 2 }] },
            options: commonOptions
        });
    }

    const ammCtx = document.getElementById('ammChart');
    if (ammCtx) {
        ammChart = new Chart(ammCtx.getContext('2d'), {
            type: 'line',
            data: { labels, datasets: [{ label: 'Amm', data: hourlyData.map(d => d.amm), borderColor: '#a855f7', tension: 0.4, pointRadius: 2 }] },
            options: commonOptions
        });
    }

    const eggsCtx = document.getElementById('eggsChart');
    if (eggsCtx) {
        eggsChart = new Chart(eggsCtx.getContext('2d'), {
            type: 'line', // Changed back to line as requested
            data: { 
                labels: farmHistory.map(h => h.date.split('-').slice(1).join('/')), // Show MM/DD
                datasets: [{ 
                    label: 'Eggs', 
                    data: farmHistory.map(h => h.eggs), 
                    borderColor: '#10b981', 
                    tension: 0.4,
                    pointRadius: 3,
                    fill: false
                }] 
            },
            options: commonOptions
        });
    }
}

function updateChart() {
    if (!tempChart || !humChart || !ammChart || !eggsChart) return;
    const labels = hourlyData.map(d => d.time);

    [tempChart, humChart, ammChart].forEach(chart => {
        chart.data.labels = labels;
    });

    tempChart.data.datasets[0].data = hourlyData.map(d => d.temp);
    humChart.data.datasets[0].data = hourlyData.map(d => d.hum);
    ammChart.data.datasets[0].data = hourlyData.map(d => d.amm);

    // Update Eggs Chart (Daily)
    eggsChart.data.labels = farmHistory.map(h => h.date.split('-').slice(1).join('/'));
    eggsChart.data.datasets[0].data = farmHistory.map(h => h.eggs);

    [tempChart, humChart, ammChart, eggsChart].forEach(chart => chart.update());
}

function startHourlyLogging() {
    if (hourlyTimer) clearInterval(hourlyTimer);
    
    // Log immediately if empty
    if (hourlyData.length === 0) logHourlyData();

    // Check every minute if an hour has passed
    hourlyTimer = setInterval(() => {
        const now = new Date();
        if (now.getMinutes() === 0) {
            logHourlyData();
        }
    }, 60000);
}

function logHourlyData() {
    const now = new Date();
    const timeStr = now.getHours().toString().padStart(2, '0') + ":00";
    const dateStr = now.toISOString().split('T')[0];

    const todayEggs = farmHistory.find(h => h.date === dateStr)?.eggs || 0;

    const entry = {
        time: timeStr,
        date: dateStr,
        temp: farmState.v0,
        hum: farmState.v1,
        amm: farmState.v2,
        eggs: todayEggs,
        timestamp: now.getTime()
    };

    hourlyData.push(entry);
    
    // Keep only last 24 hours for the graph
    if (hourlyData.length > 24) {
        // Before removing, if it's the end of the day, aggregate it
        const lastDate = hourlyData[0].date;
        if (dateStr !== lastDate) {
            aggregateDailyData(lastDate);
        }
        hourlyData.shift();
    }

    localStorage.setItem('hourly_data', JSON.stringify(hourlyData));
    updateChart();
}

function aggregateDailyData(date) {
    const dayEntries = hourlyData.filter(d => d.date === date);
    if (dayEntries.length === 0) return;

    const avgTemp = dayEntries.reduce((acc, curr) => acc + curr.temp, 0) / dayEntries.length;
    const avgHum = dayEntries.reduce((acc, curr) => acc + curr.hum, 0) / dayEntries.length;
    const avgAmm = dayEntries.reduce((acc, curr) => acc + curr.amm, 0) / dayEntries.length;
    const eggs = dayEntries[dayEntries.length - 1].eggs;

    const existingIndex = farmHistory.findIndex(h => h.date === date);
    const newEntry = { date, avgTemp, avgHum, avgAmmonia: avgAmm, eggs };

    if (existingIndex >= 0) {
        farmHistory[existingIndex] = newEntry;
    } else {
        farmHistory.unshift(newEntry);
    }

    localStorage.setItem('farm_history', JSON.stringify(farmHistory));
    renderHistory();
    addLog(`Daily summary for ${date} generated.`);
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
                avgHum: farmState.v1 || 65,
                avgAmmonia: farmState.v2 || 2,
                eggs: parseInt(count)
            });
        }
        localStorage.setItem('farm_history', JSON.stringify(farmHistory));
        renderHistory();
        updateChart();
        addLog(`Logged ${count} eggs for ${today}.`);
    }
}

function editEggLog() {
    const today = new Date().toISOString().split('T')[0];
    const existing = farmHistory.find(h => h.date === today);
    
    if (!existing) {
        addLog("No egg log found for today. Use 'Log Eggs' first.", "warn");
        return;
    }

    const newCount = prompt(`Edit eggs for today (${today}):`, existing.eggs);
    if (newCount !== null && !isNaN(newCount)) {
        existing.eggs = parseInt(newCount);
        localStorage.setItem('farm_history', JSON.stringify(farmHistory));
        renderHistory();
        updateChart();
        addLog(`Updated today's eggs to ${newCount}.`);
    }
}

function toggleAutoMode() {
    farmState.isAutoMode = !farmState.isAutoMode;
    localStorage.setItem('auto_mode', farmState.isAutoMode);
    
    // Sync Auto Mode state with Blynk (V5)
    updateBlynkPin('V5', farmState.isAutoMode ? 1 : 0);
    
    updateAutoModeUI();
    renderActuators();
    addLog(`Automatic Mode turned ${farmState.isAutoMode ? 'ON' : 'OFF'}`);
}

function updateAutoModeUI() {
    const dot = autoModeToggle.querySelector('.dot');
    if (farmState.isAutoMode) {
        autoModeToggle.classList.replace('bg-stone-300', 'bg-emerald-500');
        dot.classList.add('translate-x-6');
    } else {
        autoModeToggle.classList.replace('bg-emerald-500', 'bg-stone-300');
        dot.classList.remove('translate-x-6');
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
autoModeToggle.addEventListener('click', toggleAutoMode);
editEggBtn.addEventListener('click', editEggLog);

['v10', 'v11', 'v12', 'v13', 'v4'].forEach(pin => {
    document.getElementById(`btn-${pin}`).addEventListener('click', function() {
        if (farmState.isAutoMode) {
            addLog("Manual control is disabled while Auto Mode is ON.", "warn");
            return;
        }

        const isActive = farmState[pin] === 1;
        const targetVal = isActive ? 0 : 1;

        // 24-hour cooldown for Feed Control (V4)
        if (pin === 'v4' && targetVal === 1) {
            const now = Date.now();
            if (lastManualFeedTime !== 0 && (now - lastManualFeedTime < COOLDOWN_24H)) {
                const remainingMs = COOLDOWN_24H - (now - lastManualFeedTime);
                const hours = Math.floor(remainingMs / 3600000);
                const mins = Math.floor((remainingMs % 3600000) / 60000);
                
                addLog(`Feeding Cooldown: Please wait ${hours}h ${mins}m before manual feeding again.`, "warn");
                return;
            }
            lastManualFeedTime = now;
            localStorage.setItem('last_manual_feed_time', lastManualFeedTime);
        }

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

let isDemoMode = false;
let demoInterval = null;

function toggleDemoMode() {
    isDemoMode = !isDemoMode;
    
    if (isDemoMode) {
        demoStatus.textContent = 'ON';
        demoStatus.classList.remove('bg-stone-100', 'text-stone-400');
        demoStatus.classList.add('bg-emerald-500', 'text-white');
        addLog("Demo Mode activated. Simulating sensor fluctuations.", "success");
        
        if (!farmState.isAutoMode) {
            updateBlynkPin('V5', 1);
        }

        demoInterval = setInterval(() => {
            const randomTemp = 24 + Math.random() * 6;
            const randomHum = 45 + Math.random() * 10;
            const randomAmm = 5 + Math.random() * 10;
            
            farmState.v0 = parseFloat(randomTemp.toFixed(1));
            farmState.v1 = parseFloat(randomHum.toFixed(1));
            farmState.v2 = parseFloat(randomAmm.toFixed(1));
            
            renderSensors();
            runAutomationLogic('v0', farmState.v0);
            runAutomationLogic('v2', farmState.v2);
        }, 3000);
    } else {
        demoStatus.textContent = 'OFF';
        demoStatus.classList.add('bg-stone-100', 'text-stone-400');
        demoStatus.classList.remove('bg-emerald-500', 'text-white');
        addLog("Demo Mode deactivated.", "warning");
        clearInterval(demoInterval);
    }
}

document.getElementById('reset-feed-cooldown').addEventListener('click', () => {
    lastManualFeedTime = 0;
    localStorage.removeItem('last_manual_feed_time');
    feedCooldownTimer.classList.add('hidden');
    profileMenu.classList.add('hidden');
    addLog("Manual Feed Cooldown has been reset.", "success");
});

demoModeBtn.addEventListener('click', () => {
    toggleDemoMode();
});

profileTrigger.addEventListener('click', (e) => {
    e.stopPropagation();
    profileMenu.classList.toggle('hidden');
});

document.addEventListener('click', () => {
    profileMenu.classList.add('hidden');
});

profileMenu.addEventListener('click', (e) => {
    e.stopPropagation();
});

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

    // Update Feed Cooldown Timer
    if (lastManualFeedTime !== 0) {
        const nowMs = now.getTime();
        if (nowMs - lastManualFeedTime < COOLDOWN_24H) {
            const remainingMs = COOLDOWN_24H - (nowMs - lastManualFeedTime);
            const hours = Math.floor(remainingMs / 3600000);
            const mins = Math.floor((remainingMs % 3600000) / 60000);
            const secs = Math.floor((remainingMs % 60000) / 1000);
            
            feedCooldownTimer.textContent = `(${hours}h ${mins}m ${secs}s left)`;
            feedCooldownTimer.classList.remove('hidden');
        } else {
            feedCooldownTimer.classList.add('hidden');
        }
    }
}, 1000);
