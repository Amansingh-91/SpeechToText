// frontend/script.js

// --- DOM Element References ---
// Real-time (Browser) Tab Elements
const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const clearBtn = document.getElementById('clearBtn');
const copyBtn = document.getElementById('copyBtn');
const finalSpan = document.getElementById('final-transcript');
const interimSpan = document.getElementById('interim-transcript');
const statusIndicator = document.getElementById('statusIndicator');
const languageSelect = document.getElementById('languageSelect');

// Offline (File Upload) Tab Elements
const voskModelSelectOffline = document.getElementById('voskModelSelectOffline');
const loadVoskModelBtnOffline = document.getElementById('loadVoskModelBtnOffline');
const voskModelStatusOfflineSpan = document.getElementById('voskModelStatusOffline');
const audioFileInput = document.getElementById('audioFile');
const transcribeFileBtn = document.getElementById('transcribeFileBtn');
const clearFileTranscriptBtn = document.getElementById('clearFileTranscriptBtn');
const fileTranscriptText = document.getElementById('file-transcript-text');

// Live Vosk Tab Elements
const liveVoskStatusSpan = document.getElementById('liveVoskStatus');
const voskModelSelectLive = document.getElementById('voskModelSelectLive');
const loadVoskModelBtnLive = document.getElementById('loadVoskModelBtnLive');
const startLiveVoskBtn = document.getElementById('startLiveVoskBtn');
const stopLiveVoskBtn = document.getElementById('stopLiveVoskBtn');
const clearLiveVoskTranscriptBtn = document.getElementById('clearLiveVoskTranscriptBtn');
const liveVoskListeningIndicator = document.getElementById('liveVoskListeningIndicator');
const liveVoskFinalTranscriptSpan = document.getElementById('live-vosk-final-transcript');
const liveVoskInterimTranscriptSpan = document.getElementById('live-vosk-interim-transcript');

// Global elements
const toast = document.getElementById('status-toast');
const tabButtons = document.querySelectorAll('.tab-button');
const tabContents = document.querySelectorAll('.tab-content');

// --- Global State Variables ---
let isVoskAvailable = false; // Determined by backend (if Vosk lib is installed)
let isVoskModelLoaded = false; // Determined by backend (if ANY Vosk model has been successfully loaded on server)

let audioContext = null;
let audioSource = null;
let scriptProcessor = null;
let socket = null; // Initialize socket to null, will be created once on DOMContentLoaded
let liveVoskCurrentFinalTranscript = ""; // Accumulates final text for live Vosk
let audioStream = null; // To hold the MediaStream object from getUserMedia

// Define the target sample rate for Vosk (16kHz)
const VOSK_SAMPLE_RATE = 16000;


// --- Vosk Model Status (Offline & Live Tab - Shared Logic) ---
// This function updates the status message and button states for both Vosk-related tabs.
function updateVoskModelGlobalStatus(loaded, message = "") {
    isVoskModelLoaded = loaded; // Update global loaded state

    // Update the Offline Tab's status display
    if (loaded) {
        voskModelStatusOfflineSpan.innerHTML = `<span class="text-green-600">✅ Vosk Model Status: Loaded</span>`;
        transcribeFileBtn.disabled = false;
    } else {
        let statusText = "⚠️ Vosk Model Status: Not Loaded";
        let statusClass = "text-yellow-600";

        // Parse initial status from HTML for robustness
        const initialOfflineStatusHTML = voskModelStatusOfflineSpan.innerHTML;
        if (initialOfflineStatusHTML.includes('❌ Vosk Library Not Available')) {
            statusText = "❌ Vosk Library Not Available. Install Vosk (pip install vosk) on your server.";
            statusClass = "text-red-600";
            isVoskAvailable = false;
        } else if (initialOfflineStatusHTML.includes("❌ 'models/' directory not found")) {
            statusText = "❌ 'models/' directory not found. Please create it and place your Vosk models inside.";
            statusClass = "text-red-600";
            isVoskAvailable = true;
        } else {
            if (message) {
                statusText += `: ${message}`;
            } else if (initialOfflineStatusHTML.includes("Select a model and click 'Load Vosk Model'")) {
                statusText = "⚠️ Vosk Model Status: Not Loaded. Select a model and click 'Load Vosk Model'.";
            }
            isVoskAvailable = true;
        }
        voskModelStatusOfflineSpan.innerHTML = `<span class="${statusClass}">${statusText}</span>`;
        transcribeFileBtn.disabled = true;
    }

    // Update the Live Tab's status display based on the global loaded state
    updateLiveVoskStatus(loaded, message);

    // Disable relevant controls if Vosk library isn't available
    if (!isVoskAvailable) {
        loadVoskModelBtnOffline.disabled = true;
        voskModelSelectOffline.disabled = true;
        loadVoskModelBtnLive.disabled = true;
        voskModelSelectLive.disabled = true;
    } else {
        // Only re-enable if not already loading
        if (!loadVoskModelBtnOffline.classList.contains('loading')) {
            loadVoskModelBtnOffline.disabled = false;
            voskModelSelectOffline.disabled = false;
        }
        if (!loadVoskModelBtnLive.classList.contains('loading')) {
            loadVoskModelBtnLive.disabled = false;
            voskModelSelectLive.disabled = false;
        }
    }
}

// Function to update the Live Vosk specific status display and button states
function updateLiveVoskStatus(loaded, message = "") {
    if (loaded) {
        liveVoskStatusSpan.innerHTML = `<span class="text-green-600">✅ Live Vosk Ready: Model loaded.</span>`;
        // Only enable start button if a model is loaded and no audio processing is active
        if (!(audioContext && audioContext.state === 'running')) {
            startLiveVoskBtn.disabled = false;
        }
    } else {
        let statusText = "⚠️ Live Vosk Not Ready: Please load a model.";
        let statusClass = "text-yellow-600";

        const initialLiveStatusHTML = liveVoskStatusSpan.innerHTML;
        if (initialLiveStatusHTML.includes('❌ Vosk Library Not Available') || message.includes('Vosk library not available')) {
            statusText = "❌ Vosk Library Not Available. Install Vosk (pip install vosk) on your server.";
            statusClass = "text-red-600";
            isVoskAvailable = false;
        } else if (message.includes("Model directory not found") || message.includes("Failed to load Vosk model")) {
             statusText = `❌ Live Vosk Not Ready: ${message}`;
             statusClass = "text-red-600";
             isVoskAvailable = true;
        } else if (message) { // Generic message from backend if not explicitly handled
            statusText = `⚠️ Live Vosk Not Ready: ${message}`;
        }
        
        liveVoskStatusSpan.innerHTML = `<span class="${statusClass}">${statusText}</span>`;
        startLiveVoskBtn.disabled = true; // Disable start button if not ready or not loaded
        stopLiveVoskBtn.disabled = true; // Ensure stop is disabled initially
    }
}


// --- Web Speech API (Real-time Browser) Logic ---
const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
let recognition;
let finalTranscript = ""; // Stores the accumulated final transcription for Real-time tab

if (SpeechRecognition) {
    recognition = new SpeechRecognition();
    recognition.lang = languageSelect.value || 'en-US'; // Set initial language
    recognition.continuous = true;
    recognition.interimResults = true;

    recognition.onstart = () => {
        startBtn.disabled = true;
        stopBtn.disabled = false;
        statusIndicator.classList.remove('hidden');
        showToast("🎙️ Listening...");
    };

    recognition.onresult = (event) => {
        let currentInterimTranscript = '';
        for (let i = event.resultIndex; i < event.results.length; ++i) {
            const transcriptPart = event.results[i][0].transcript;
            if (event.results[i].isFinal) {
                finalTranscript += transcriptPart + ' ';
            } else {
                currentInterimTranscript += transcriptPart;
            }
        }
        finalSpan.innerText = finalTranscript;
        interimSpan.innerText = currentInterimTranscript;
    };

    recognition.onend = () => {
        startBtn.disabled = false;
        stopBtn.disabled = true;
        statusIndicator.classList.add('hidden');
        showToast("⏹️ Recognition Stopped.");
    };

    recognition.onerror = (event) => {
        console.error('Speech recognition error:', event.error);
        let errorMessage = 'Recognition error: ';
        switch(event.error) {
            case 'not-allowed':
                errorMessage += 'Microphone access denied. Please allow microphone permissions in your browser settings.';
                break;
            case 'no-speech':
                errorMessage += 'No speech detected. Please speak clearly.';
                break;
            case 'audio-capture':
                errorMessage += 'Audio capture failed. Check your microphone.';
                break;
            case 'network':
                errorMessage += 'Network error. Check your internet connection.';
                break;
            default:
                errorMessage += event.error;
        }
        finalSpan.innerText = `❌ ${errorMessage}`;
        interimSpan.innerText = "";
        showToast(`❌ Error: ${errorMessage}`);
        stopRecognition(); // Attempt to stop recognition on error
    };

    languageSelect.addEventListener('change', () => {
        if (startBtn.disabled) {
            recognition.stop();
        }
        recognition.lang = languageSelect.value;
        showToast(`Language set to: ${languageSelect.options[languageSelect.selectedIndex].text}`);
    });

} else {
    finalSpan.innerText = "❌ Speech recognition not supported in this browser. Please use Chrome or Edge for full functionality.";
    startBtn.disabled = true;
    stopBtn.disabled = true;
    languageSelect.disabled = true;
    showToast("❌ Browser not supported.");
}

// --- Real-time Tab Functions ---
function startRecognition() {
    if (recognition && !startBtn.disabled) {
        finalTranscript = "";
        finalSpan.innerText = "Listening...";
        interimSpan.innerText = "";
        recognition.start();
    }
}

function stopRecognition() {
    if (recognition && !stopBtn.disabled) {
        recognition.stop();
    }
}

function clearTranscript() {
    finalTranscript = "";
    finalSpan.innerText = "Your speech will appear here...";
    interimSpan.innerText = "";
    showToast("🗑️ Transcript cleared.");
}

function copyTranscript() {
    const textToCopy = finalSpan.innerText;
    if (!textToCopy || textToCopy === "Your speech will appear here...") {
        showToast("Nothing to copy.");
        return;
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(textToCopy).then(() => {
            showToast("✅ Copied to clipboard!");
        }).catch(err => {
            console.error('Failed to copy text: ', err);
            fallbackCopyTextToClipboard(textToCopy);
        });
    } else {
        fallbackCopyTextToClipboard(textToCopy);
    }
}

function fallbackCopyTextToClipboard(text) {
    const textArea = document.createElement("textarea");
    textArea.value = text;
    textArea.style.top = "0";
    textArea.style.left = "0";
    textArea.style.position = "fixed";
    document.body.appendChild(textArea);
    textArea.focus();
    textArea.select();
    try {
        const successful = document.execCommand('copy');
        if (successful) {
            showToast("✅ Copied to clipboard! (Fallback)");
        } else {
            showToast("❌ Copy failed. Please copy manually.");
        }
    } catch (err) {
        showToast("❌ Copy failed. Please copy manually.");
    }
    document.body.removeChild(textArea);
}

// --- Vosk Model Loading (Common Function for both Offline and Live Tabs) ---
async function loadVoskModel(modelName) {
    // Ensure Vosk library is available as indicated by initial HTML render
    if (!isVoskAvailable) {
        showToast("❌ Vosk library is not available on the server. Please install it (pip install vosk).");
        return;
    }

    if (!modelName) {
        showToast("Please select a Vosk model from the dropdown.");
        return;
    }

    // Update status in both tabs to indicate loading
    updateVoskModelGlobalStatus(false, "Loading Vosk model..."); 
    // Add a loading class to disable hover effects and indicate loading visually
    loadVoskModelBtnOffline.classList.add('loading');
    loadVoskModelBtnLive.classList.add('loading');
    loadVoskModelBtnOffline.disabled = true;
    voskModelSelectOffline.disabled = true;
    loadVoskModelBtnLive.disabled = true;
    voskModelSelectLive.disabled = true;

    try {
        const response = await fetch('/load-vosk-model', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ modelName: modelName })
        });

        if (!response.ok) {
            const errorData = await response.json();
            throw new Error(errorData.message || `HTTP error! status: ${response.status}`);
        }

        const data = await response.json();
        // Update global status based on backend response
        updateVoskModelGlobalStatus(data.liveModelLoaded, data.message); 
        showToast(data.message);

        // If the model was successfully loaded, re-initialize the live recognizer on the backend
        // This is crucial for handling model changes
        if (data.liveModelLoaded && socket && socket.connected) { //
            socket.emit('init_live_recognizer'); //
            console.log("Emitted 'init_live_recognizer' to server after model load.");
            // Also stop any ongoing live transcription if a model was just changed
            stopLiveVoskTranscription(); //
        }
        
    } catch (error) {
        console.error('Failed to load Vosk model:', error);
        // Update global status with error message
        updateVoskModelGlobalStatus(false, `Failed to load model: ${error.message}`);
        showToast(`❌ Failed to load model: ${error.message}`);
    } finally {
        // Remove loading class and re-enable buttons/dropdowns
        loadVoskModelBtnOffline.classList.remove('loading');
        loadVoskModelBtnLive.classList.remove('loading');
        // Re-enable if model is loaded globally, otherwise stay disabled (handled by updateVoskModelGlobalStatus)
        if (isVoskModelLoaded) {
            loadVoskModelBtnOffline.disabled = false;
            voskModelSelectOffline.disabled = false;
            loadVoskModelBtnLive.disabled = false;
            voskModelSelectLive.disabled = false;
        }
    }
}


// --- Offline (File Upload) Tab Logic ---

loadVoskModelBtnOffline.addEventListener('click', () => {
    loadVoskModel(voskModelSelectOffline.value); // Call common function
});


transcribeFileBtn.addEventListener('click', async () => {
    if (!isVoskModelLoaded) { // Check global loaded state
        showToast("⚠️ Vosk model is not loaded. Please load a model first using the 'Load Vosk Model' button.");
        return;
    }

    const file = audioFileInput.files[0];
    if (!file) {
        showToast("Please select an audio file first.");
        return;
    }

    fileTranscriptText.innerText = "Uploading and transcribing... please wait.";
    transcribeFileBtn.disabled = true;
    showToast("Uploading file...");

    const formData = new FormData();
    formData.append('audioFile', file);

    try {
        const response = await fetch('/transcribe-vosk', {
            method: 'POST',
            body: formData,
        });

        if (!response.ok) {
            const errorData = await response.json();
            throw new Error(errorData.error || `HTTP error! status: ${response.status}`);
        }

        const data = await response.json();
        fileTranscriptText.innerText = data.transcript || "No transcription available.";
        showToast("✅ Transcription complete!");
    } catch (error) {
        console.error('Transcription failed:', error);
        fileTranscriptText.innerText = `❌ Error: ${error.message}`;
        showToast(`❌ Transcription failed: ${error.message}`);
    } finally {
        transcribeFileBtn.disabled = false;
    }
});

clearFileTranscriptBtn.addEventListener('click', () => {
    fileTranscriptText.innerText = "Upload an audio file and click 'Transcribe File' to see the result here...";
    audioFileInput.value = '';
    showToast("🗑️ File transcription cleared.");
});


// --- Live Mic (Vosk) Tab Logic ---

loadVoskModelBtnLive.addEventListener('click', () => {
    loadVoskModel(voskModelSelectLive.value); // Call common function
});

startLiveVoskBtn.addEventListener('click', async () => {
    if (!isVoskModelLoaded) { // Check global loaded state
        showToast("⚠️ Vosk model not ready for live transcription. Load a model using the 'Load Vosk Model' button.");
        return;
    }
    
    // Check if audio processing is already active
    if (audioContext && audioContext.state === 'running') {
        showToast("Live transcription is already running.");
        return;
    }

    // Ensure socket is connected before starting audio processing
    if (!socket || !socket.connected) {
        showToast("Connecting to live transcription service...");
        // This should trigger the 'connect' event handler which then calls startAudioProcessing()
        socket.connect(); 
        return; // Exit and wait for 'connect' event
    }

    startAudioProcessing(); // Proceed if socket is already connected
});

async function startAudioProcessing() {
    // Reset transcripts
    liveVoskCurrentFinalTranscript = "";
    liveVoskFinalTranscriptSpan.innerText = "Listening...";
    liveVoskInterimTranscriptSpan.innerText = "";

    try {
        // Request microphone access
        audioStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        
        // Create AudioContext
        audioContext = new (window.AudioContext || window.webkitAudioContext)({
            sampleRate: VOSK_SAMPLE_RATE // Target sample rate for Vosk
        });
        
        // Create an audio source from the microphone stream
        audioSource = audioContext.createMediaStreamSource(audioStream);
        
        // Create a ScriptProcessorNode to process audio chunks
        // Buffer size (e.g., 4096) and number of input/output channels (1 for mono)
        scriptProcessor = audioContext.createScriptProcessor(4096, 1, 1); 
        
        // Connect the nodes: microphone source -> script processor -> audio context destination (for playback/monitoring if needed)
        audioSource.connect(scriptProcessor);
        scriptProcessor.connect(audioContext.destination);

        // This is where the audio data is processed
        scriptProcessor.onaudioprocess = (event) => {
            // Get the raw audio data (Float32Array)
            const inputBuffer = event.inputBuffer.getChannelData(0); // Get mono channel

            // Convert Float32Array to Int16Array (16-bit PCM)
            const int16Buffer = new Int16Array(inputBuffer.length);
            for (let i = 0; i < inputBuffer.length; i++) {
                int16Buffer[i] = Math.min(1, Math.max(-1, inputBuffer[i])) * 0x7FFF; // Scale to 16-bit
            }
            
            // Send raw audio data as Uint8Array (bytes) to backend via WebSocket
            if (socket && socket.connected) {
                socket.emit('audio_chunk', { audio: new Uint8Array(int16Buffer.buffer) });
            }
        };
        
        startLiveVoskBtn.disabled = true;
        stopLiveVoskBtn.disabled = false;
        liveVoskListeningIndicator.classList.remove('hidden');
        showToast("🎙️ Live transcription started.");

    } catch (error) {
        console.error('Error starting live Vosk transcription:', error);
        liveVoskFinalTranscriptSpan.innerText = `❌ Error: ${error.message}`;
        showToast(`❌ Error accessing microphone: ${error.message}`);
        stopLiveVoskTranscription(); // Clean up on error
    }
}


// Function to handle stopping live Vosk transcription
stopLiveVoskBtn.addEventListener('click', () => {
    stopLiveVoskTranscription();
    showToast("⏹️ Live transcription stopped.");
});

function stopLiveVoskTranscription() {
    // Disconnect audio nodes and close AudioContext
    if (scriptProcessor) {
        scriptProcessor.onaudioprocess = null; // Clear event listener
        scriptProcessor.disconnect();
        scriptProcessor = null;
    }
    if (audioSource) {
        audioSource.disconnect();
        audioSource = null;
    }
    if (audioContext && audioContext.state !== 'closed') {
        audioContext.close().then(() => {
            console.log('AudioContext closed.');
            audioContext = null;
        }).catch(e => console.error('Error closing AudioContext:', e));
    }
    
    // Stop all tracks to release microphone
    if (audioStream) {
        audioStream.getTracks().forEach(track => track.stop());
        audioStream = null; // Clear reference
    }
    
    // Send stop signal to backend, but DO NOT disconnect the socket unless page is closing
    if (socket && socket.connected) {
        socket.emit('stop_live_transcription'); 
        console.log("Emitted 'stop_live_transcription' to server.");
    }

    startLiveVoskBtn.disabled = false;
    stopLiveVoskBtn.disabled = true;
    liveVoskListeningIndicator.classList.add('hidden');
}


clearLiveVoskTranscriptBtn.addEventListener('click', () => {
    stopLiveVoskTranscription(); // Stop any active transcription first
    liveVoskCurrentFinalTranscript = "";
    liveVoskFinalTranscriptSpan.innerText = "Start live transcription to see the result here...";
    liveVoskInterimTranscriptSpan.innerText = "";
    showToast("🗑️ Live transcription cleared.");
});


// --- Global Functions ---
function showToast(message) {
    toast.innerText = message;
    toast.classList.remove('opacity-0');
    toast.classList.add('opacity-100');
    setTimeout(() => {
        toast.classList.remove('opacity-100');
        toast.classList.add('opacity-0');
    }, 3000);
}

// --- Tab Switching Logic ---
tabButtons.forEach(button => {
    button.addEventListener('click', () => {
        // Deactivate all tab buttons and hide all tab contents
        tabButtons.forEach(btn => btn.classList.remove('active'));
        tabContents.forEach(content => content.classList.remove('active'));

        // Activate the clicked button and show its corresponding content
        const tabId = button.dataset.tab;
        document.getElementById(`${tabId}-tab-content`).classList.add('active');
        button.classList.add('active');

        // Stop any active real-time browser API recognition when switching tabs
        if (recognition && startBtn.disabled) {
            recognition.stop();
        }
        // Stop any active live Vosk transcription when switching tabs
        stopLiveVoskTranscription();

        // Clear toasts when switching tabs
        showToast(""); // Hide current toast
    });
});

// --- Event Listeners ---
startBtn.addEventListener('click', startRecognition);
stopBtn.addEventListener('click', stopRecognition);
clearBtn.addEventListener('click', clearTranscript);
copyBtn.addEventListener('click', copyTranscript);


// Initial Socket.IO connection when the page loads.
// This ensures a single connection for the duration of the page.
document.addEventListener('DOMContentLoaded', () => {
    // These functions read initial states from the HTML rendered by Flask
    updateVoskModelGlobalStatus(false); // Call this first to set initial UI state

    // Initialize Socket.IO connection only once on page load
    socket = io.connect(window.location.protocol + '//' + document.domain + ':' + location.port, {
        autoConnect: false // Do not auto-connect, we'll manually connect later
    });

    socket.on('connect', () => {
        console.log('Socket.IO connected!');
        showToast("Server connection established.");
        // When connected, also send a status check to the server if needed
        // to ensure Vosk recognizer is ready for this session.
        // The server's 'connect' handler already does this implicitly.
    });

    socket.on('disconnect', () => {
        console.log('Socket.IO disconnected!');
        showToast("Server connection lost.");
        // If the socket disconnects unexpectedly, ensure audio processing is stopped
        stopLiveVoskTranscription(); 
    });

    socket.on('vosk_live_status', (data) => {
        console.log('Live Vosk Status from server:', data.message);
        showToast(`Server: ${data.message}`);
        updateVoskModelGlobalStatus(data.loaded, data.message);
        // If a model was newly loaded on the server and we get a success message,
        // we might want to automatically re-enable the start button if applicable,
        // which `updateVoskModelGlobalStatus` already handles.
    });

    socket.on('transcript_result', (data) => {
        // Only update UI if we are on the live vosk tab
        if (document.getElementById('live-vosk-tab-content').classList.contains('active')) {
            if (data.type === 'final') {
                liveVoskCurrentFinalTranscript += data.text + ' ';
                liveVoskFinalTranscriptSpan.innerText = liveVoskCurrentFinalTranscript;
                liveVoskInterimTranscriptSpan.innerText = ''; // Clear interim after final
            } else if (data.type === 'partial') {
                liveVoskInterimTranscriptSpan.innerText = data.text;
            }
        }
    });

    // Optionally connect the socket immediately on load, or when the live tab is first accessed
    // For now, it connects when startLiveVoskBtn is clicked for the first time.
    // If you want it always connected: socket.connect();
});

// Disconnect socket when window is closed/reloaded to ensure cleanup on server
window.addEventListener('beforeunload', () => {
    // Stop any active live transcription first
    stopLiveVoskTranscription();
    // Then disconnect the socket
    if (socket && socket.connected) {
        socket.disconnect();
        console.log("Socket.IO disconnected on window unload.");
    }
});