
# backend/app.py

from flask import Flask, send_from_directory, render_template, request, jsonify
from flask_socketio import SocketIO, emit
import os
import json
import tempfile
import wave
import numpy as np

try:
    import vosk
    VOSK_AVAILABLE = True
except ImportError:
    VOSK_AVAILABLE = False
    print("WARNING: Vosk library not found. Offline transcription features will be disabled.")

try:
    import librosa
    LIBROSA_AVAILABLE = True
except ImportError:
    LIBROSA_AVAILABLE = False
    print("WARNING: Librosa library not found. Only 16-bit, 16kHz mono PCM WAV files are supported for Vosk.")


# Adjust MODELS_ROOT_DIR to point to Render's persistent disk mount point.
# On Render, persistent disks are mounted at /var/data.
# We will upload your models into /var/data/models.
MODELS_ROOT_DIR = os.path.join('/var', 'data', 'models')

# BASE_DIR = os.path.dirname(os.path.abspath(__file__))
# CERT_PATH = os.path.join(BASE_DIR, 'cert.pem')
# KEY_PATH = os.path.join(BASE_DIR, 'key.pem')
# MODELS_ROOT_DIR = os.path.join(BASE_DIR, '../models')

BROWSER_LANGUAGE_OPTIONS = [
    ("en-US", "English (US)"), ("en-GB", "English (UK)"), ("en-IN", "English (India)"),
    ("hi-IN", "हिंदी (Hindi)"), ("es-ES", "Español (España)"), ("fr-FR", "Français (France)"),
    ("de-DE", "Deutsch (Deutschland)"), ("it-IT", "Italian (Italy)"), ("pt-BR", "Portuguese (Brazil)"),
    ("ru-RU", "Russian"), ("ja-JP", "Japanese"), ("ko-KR", "Korean"), ("zh-CN", "Chinese (Simplified)")
]

AVAILABLE_VOSK_MODELS = [
    "vosk-model-small-hi-0.22",
    "vosk-model-en-in-0.5",
    "vosk-model-small-en-us-0.15"
]

app = Flask(__name__,
            template_folder=os.path.join(BASE_DIR, '../frontend'),
            static_folder=os.path.join(BASE_DIR, '../frontend'))

socketio = SocketIO(app, cors_allowed_origins="*", logger=True, engineio_logger=True)

class VoskSpeechRecognizer:
    def __init__(self, model_path: str, sample_rate=16000):
        if not VOSK_AVAILABLE:
            raise ImportError("Vosk library not found.")
        self.model_path = model_path
        self.model = None
        self.sample_rate = sample_rate
        self.load_model()

    def load_model(self):
        try:
            if not os.path.exists(self.model_path):
                print(f"Model path does not exist: {self.model_path}")
                return False
            self.model = vosk.Model(self.model_path)
            print(f"Vosk model loaded from: {self.model_path}")
            return True
        except Exception as e:
            print(f"Failed to load model: {e}")
            return False

    def transcribe_audio_file(self, path):
        if not self.model:
            return "Error: No model loaded"
        try:
            if LIBROSA_AVAILABLE:
                audio, _ = librosa.load(path, sr=self.sample_rate, mono=True)
                audio_int16 = (audio * 32767).astype(np.int16)
            else:
                with wave.open(path, 'rb') as wf:
                    if wf.getnchannels() != 1 or wf.getsampwidth() != 2 or wf.getframerate() != self.sample_rate:
                        return "Unsupported WAV format"
                    audio_int16 = np.frombuffer(wf.readframes(wf.getnframes()), dtype=np.int16)
            rec = vosk.KaldiRecognizer(self.model, self.sample_rate)
            rec.SetWords(True)
            transcript = ""
            for i in range(0, len(audio_int16), 4000):
                chunk = audio_int16[i:i+4000]
                if rec.AcceptWaveform(chunk.tobytes()):
                    transcript += json.loads(rec.Result()).get("text", "") + " "
            transcript += json.loads(rec.FinalResult()).get("text", "")
            return transcript.strip()
        except Exception as e:
            return f"Error: {e}"

live_vosk_recognizers = {}
live_vosk_model = None # This will store the actual vosk.Model object
current_loaded_model_name = None # To keep track of the currently loaded model name

@app.before_request
def before_request():
    if not hasattr(app, 'vosk_recognizer_instance'):
        app.vosk_recognizer_instance = None

@app.route('/')
def index():
    # Pass the current loaded model name to the frontend to set the correct dropdown selection
    return render_template('index.html',
                           browser_language_options=BROWSER_LANGUAGE_OPTIONS,
                           available_vosk_models=AVAILABLE_VOSK_MODELS,
                           vosk_model_loaded=bool(getattr(app, 'vosk_recognizer_instance', None)),
                           live_vosk_model_loaded=bool(live_vosk_model and hasattr(live_vosk_model, 'model')),
                           vosk_available=VOSK_AVAILABLE,
                           models_dir_exists=os.path.exists(MODELS_ROOT_DIR),
                           current_loaded_model_name=current_loaded_model_name)

@app.route('/load-vosk-model', methods=['POST'])
def load_vosk_model():
    global live_vosk_model, current_loaded_model_name
    if not VOSK_AVAILABLE:
        return jsonify(success=False, message="Vosk not available"), 500
    model_name = request.get_json().get('modelName')
    if not model_name or model_name not in AVAILABLE_VOSK_MODELS:
        return jsonify(success=False, message="Invalid model"), 400
    
    # If the requested model is already loaded, do nothing and report success
    if current_loaded_model_name == model_name and live_vosk_model is not None:
        return jsonify(success=True, message=f"Model '{model_name}' already loaded.", liveModelLoaded=True)

    model_path = os.path.normpath(os.path.join(MODELS_ROOT_DIR, model_name))
    if not os.path.exists(model_path):
        return jsonify(success=False, message="Model not found"), 404
    try:
        # Clear existing recognizers for all clients as the model is changing
        for sid in list(live_vosk_recognizers.keys()):
            # Optionally, send a message to clients that their recognizer is being reset
            # Use socketio.emit directly for broadcasting from a Flask route
            socketio.emit('vosk_live_status', {'loaded': False, 'message': 'Model changed, please restart transcription.'}, room=sid)
            if sid in live_vosk_recognizers: # Check again in case it was deleted by another thread/event
                del live_vosk_recognizers[sid]
        print("Cleared all live Vosk recognizers due to model change.")

        recognizer = VoskSpeechRecognizer(model_path)
        app.vosk_recognizer_instance = recognizer
        live_vosk_model = recognizer.model # Store the vosk.Model object
        current_loaded_model_name = model_name # Update the tracker
        
        # Notify all connected clients that a new model has been loaded
        # They should then re-initialize their recognizers for live transcription
        # Corrected: Removed 'broadcast=True' and rely on default behavior of socketio.emit
        socketio.emit('vosk_live_status', {'loaded': True, 'message': f"Model '{model_name}' loaded. Ready for transcription."}) 
        return jsonify(success=True, message=f"Model '{model_name}' loaded.", liveModelLoaded=True)
    except Exception as e:
        live_vosk_model = None
        current_loaded_model_name = None
        return jsonify(success=False, message=str(e)), 500

@app.route('/transcribe-vosk', methods=['POST'])
def transcribe_vosk():
    if not VOSK_AVAILABLE or not getattr(app, 'vosk_recognizer_instance', None):
        return jsonify(error="Model not loaded"), 400
    if 'audioFile' not in request.files:
        return jsonify(error="No file"), 400
    file = request.files['audioFile']
    if file.filename == '':
        return jsonify(error="Empty filename"), 400
    temp_dir = tempfile.mkdtemp()
    temp_path = os.path.join(temp_dir, file.filename)
    try:
        file.save(temp_path)
        result = app.vosk_recognizer_instance.transcribe_audio_file(temp_path)
        return jsonify(transcript=result)
    finally:
        if os.path.exists(temp_path): os.remove(temp_path)
        if os.path.exists(temp_dir): os.rmdir(temp_dir)

@app.route('/<path:filename>')
def serve_static(filename):
    return send_from_directory(app.static_folder, filename)

@socketio.on('connect')
def on_connect():
    print(f"Client connected: {request.sid}")
    if not live_vosk_model: # If no model is globally loaded on the server
        emit('vosk_live_status', {'loaded': False, 'message': 'No Vosk model loaded on server.'})
        return
    # On connect, always try to create a recognizer for the current model
    # This covers cases where a model was loaded before this client connected
    try:
        rec = vosk.KaldiRecognizer(live_vosk_model, 16000)
        rec.SetWords(True)
        live_vosk_recognizers[request.sid] = rec
        emit('vosk_live_status', {'loaded': True, 'message': 'Vosk model ready. You can start live transcription.'})
    except Exception as e:
        emit('vosk_live_status', {'loaded': False, 'message': f'Error initializing recognizer: {e}'})

@socketio.on('init_live_recognizer')
def init_live_recognizer():
    print(f"Reinitializing recognizer for: {request.sid}")
    if request.sid in live_vosk_recognizers:
        del live_vosk_recognizers[request.sid] # Clear existing one

    if not live_vosk_model:
        emit('vosk_live_status', {'loaded': False, 'message': 'No Vosk model loaded on server.'})
        return
    try:
        rec = vosk.KaldiRecognizer(live_vosk_model, 16000)
        rec.SetWords(True)
        live_vosk_recognizers[request.sid] = rec
        emit('vosk_live_status', {'loaded': True, 'message': 'Recognizer reinitialized. Ready to start.'})
    except Exception as e:
        emit('vosk_live_status', {'loaded': False, 'message': f"Init error: {e}"})

@socketio.on('audio_chunk')
def handle_chunk(data):
    # Ensure the recognizer exists for the current session ID before processing
    if request.sid not in live_vosk_recognizers:
        print(f"No recognizer for SID {request.sid}. Skipping audio chunk.")
        # Optionally, emit an error back to the client or a status message
        return
    rec = live_vosk_recognizers[request.sid]
    audio = data['audio']
    if rec.AcceptWaveform(audio):
        emit('transcript_result', {'type': 'final', 'text': json.loads(rec.Result()).get("text", "")})
    else:
        emit('transcript_result', {'type': 'partial', 'text': json.loads(rec.PartialResult()).get("partial", "")})

@socketio.on('stop_live_transcription')
def stop_transcription():
    if request.sid in live_vosk_recognizers:
        rec = live_vosk_recognizers[request.sid]
        # Emit final result before deleting the recognizer
        emit('transcript_result', {'type': 'final', 'text': json.loads(rec.FinalResult()).get("text", "")})
        del live_vosk_recognizers[request.sid]
        print(f"Stopped transcription and deleted recognizer for: {request.sid}")
    else:
        print(f"No active recognizer for SID {request.sid} to stop.")

@socketio.on('disconnect')
def on_disconnect():
    print(f"Client disconnected: {request.sid}")
    if request.sid in live_vosk_recognizers:
        del live_vosk_recognizers[request.sid]
        print(f"Cleaned up recognizer for disconnected client: {request.sid}")

if __name__ == '__main__':
    try:
        # if not os.path.exists(CERT_PATH) or not os.path.exists(KEY_PATH):
        #     print("Running in HTTP mode (no certs)")
        #     socketio.run(app, debug=True, host='0.0.0.0', port=5000)
        # else:
        #     print("Running in HTTPS mode")
        #     socketio.run(app, debug=True, host='0.0.0.0', port=5000, ssl_context=(CERT_PATH, KEY_PATH))
        # Remove or ignore the SSL context check here as Render provides HTTPS
        socketio.run(app, debug=True, host='0.0.0.0', port=5000)
    except Exception as e:
        print(f"Startup error: {e}")
        print("Falling back to HTTP")
        socketio.run(app, debug=True, host='127.0.0.1', port=5000)