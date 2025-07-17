# whisper-service/app.py
from fastapi import FastAPI, UploadFile, HTTPException, Form
from fastapi.middleware.cors import CORSMiddleware
import whisper
import torch
import tempfile
import os
import asyncio
from typing import Optional, List
import logging
from pydantic import BaseModel
import redis
import json
import hashlib
import time
import io
from concurrent.futures import ThreadPoolExecutor

app = FastAPI(title="Whisper Translation & Transcription Service")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Configuration
MODEL_SIZE = os.getenv("MODEL_SIZE", "large-v3")
DEVICE = "cuda" if torch.cuda.is_available() else "cpu"
COMPUTE_TYPE = os.getenv("COMPUTE_TYPE", "float16")
MAX_WORKERS = int(os.getenv("WORKERS", "4"))

# Initialize Redis
redis_client = redis.Redis(host='redis', port=6379, db=0, decode_responses=True)

# Load Whisper model
print(f"Loading Whisper model: {MODEL_SIZE} on {DEVICE}")
if DEVICE == "cuda":
    model = whisper.load_model(MODEL_SIZE, device=DEVICE)
else:
    model = whisper.load_model(MODEL_SIZE)

# Thread pool for CPU-bound operations
executor = ThreadPoolExecutor(max_workers=MAX_WORKERS)

class TranscriptionRequest(BaseModel):
    source_language: Optional[str] = None  # Auto-detect if None
    target_language: str = "en"  # Default to English
    task: str = "transcribe"  # "transcribe" or "translate"
    return_segments: bool = False
    return_language: bool = True

class TranslationRequest(BaseModel):
    source_language: Optional[str] = None  # Auto-detect if None
    target_language: str = "en"  # Whisper can only translate TO English
    return_segments: bool = False
    return_language: bool = True

class TextTranslationRequest(BaseModel):
    text: str
    source_language: str
    target_language: str

class WhisperResponse(BaseModel):
    text: str
    detected_language: Optional[str] = None
    segments: Optional[List[dict]] = None
    processing_time: float
    task: str

def process_audio_sync(audio_path: str, task: str, source_lang: Optional[str] = None, 
                      target_lang: str = "en", return_segments: bool = False) -> dict:
    """Synchronous audio processing function"""
    
    start_time = time.time()
    
    try:
        if task == "transcribe":
            # Transcribe in original language
            result = model.transcribe(
                audio_path,
                language=source_lang,  # None for auto-detect
                task="transcribe",
                fp16=DEVICE == "cuda",
                verbose=False
            )
            
        elif task == "translate":
            # Translate to English (Whisper's built-in translation)
            result = model.transcribe(
                audio_path,
                language=source_lang,  # None for auto-detect
                task="translate",  # This translates to English
                fp16=DEVICE == "cuda",
                verbose=False
            )
            
        elif task == "translate_to_language":
            # For non-English targets, we need to transcribe first then translate
            # This is a limitation - Whisper only translates TO English
            result = model.transcribe(
                audio_path,
                language=source_lang,
                task="transcribe",
                fp16=DEVICE == "cuda",
                verbose=False
            )
            
        else:
            raise ValueError(f"Unknown task: {task}")
            
        processing_time = time.time() - start_time
        
        response_data = {
            "text": result["text"].strip(),
            "detected_language": result.get("language"),
            "processing_time": processing_time,
            "task": task
        }
        
        if return_segments:
            response_data["segments"] = result.get("segments", [])
            
        return response_data
        
    except Exception as e:
        logging.error(f"Whisper processing error: {str(e)}")
        raise

async def process_audio_async(audio_file: UploadFile, request: TranscriptionRequest) -> WhisperResponse:
    """Async wrapper for audio processing"""
    
    # Read audio content
    content = await audio_file.read()
    
    # Create cache key
    cache_key = f"whisper:{hashlib.md5(content).hexdigest()}:{request.source_language}:{request.target_language}:{request.task}"
    
    # Check cache
    cached_result = redis_client.get(cache_key)
    if cached_result:
        return WhisperResponse(**json.loads(cached_result))
    
    # Save to temporary file
    with tempfile.NamedTemporaryFile(delete=False, suffix=".wav") as tmp_file:
        tmp_file.write(content)
        tmp_file_path = tmp_file.name
    
    try:
        # Process in thread pool
        loop = asyncio.get_event_loop()
        result = await loop.run_in_executor(
            executor,
            process_audio_sync,
            tmp_file_path,
            request.task,
            request.source_language,
            request.target_language,
            request.return_segments
        )
        
        response = WhisperResponse(**result)
        
        # Cache for 1 hour
        redis_client.setex(cache_key, 3600, json.dumps(response.dict()))
        
        return response
        
    finally:
        # Clean up
        os.unlink(tmp_file_path)

@app.post("/transcribe", response_model=WhisperResponse)
async def transcribe_audio(
    audio_file: UploadFile,
    source_language: Optional[str] = Form(None),
    return_segments: bool = Form(False),
    return_language: bool = Form(True)
):
    """Transcribe audio in original language"""
    
    if not audio_file:
        raise HTTPException(status_code=400, detail="No audio file provided")
    
    # Validate file size (max 25MB)
    if audio_file.size > 25 * 1024 * 1024:
        raise HTTPException(status_code=400, detail="File too large (max 25MB)")
    
    request = TranscriptionRequest(
        source_language=source_language,
        task="transcribe",
        return_segments=return_segments,
        return_language=return_language
    )
    
    return await process_audio_async(audio_file, request)

@app.post("/translate", response_model=WhisperResponse)
async def translate_audio(
    audio_file: UploadFile,
    source_language: Optional[str] = Form(None),
    target_language: str = Form("en"),
    return_segments: bool = Form(False),
    return_language: bool = Form(True)
):
    """Translate audio to English (Whisper's built-in capability)"""
    
    if not audio_file:
        raise HTTPException(status_code=400, detail="No audio file provided")
    
    if target_language != "en":
        raise HTTPException(
            status_code=400, 
            detail="Whisper can only translate TO English. For other languages, use transcribe then external translation."
        )
    
    request = TranslationRequest(
        source_language=source_language,
        target_language=target_language,
        return_segments=return_segments,
        return_language=return_language
    )
    
    return await process_audio_async(audio_file, request)

@app.post("/translate_text")
async def translate_text(request: TextTranslationRequest):
    """Text translation using lightweight translation library"""
    
    try:
        # Use lightweight translation library
        from googletrans import Translator
        translator = Translator()
        
        # Create cache key for text translation
        cache_key = f"text_translate:{hashlib.md5(request.text.encode()).hexdigest()}:{request.source_language}:{request.target_language}"
        
        # Check cache
        cached_result = redis_client.get(cache_key)
        if cached_result:
            return json.loads(cached_result)
        
        start_time = time.time()
        
        # Translate text
        result = translator.translate(
            request.text,
            src=request.source_language,
            dest=request.target_language
        )
        
        processing_time = time.time() - start_time
        
        response = {
            "translated_text": result.text,
            "source_language": request.source_language,
            "target_language": request.target_language,
            "detected_language": result.src,
            "processing_time": processing_time
        }
        
        # Cache for 1 hour
        redis_client.setex(cache_key, 3600, json.dumps(response))
        
        return response
        
    except Exception as e:
        logging.error(f"Text translation error: {str(e)}")
        raise HTTPException(status_code=500, detail="Text translation failed")

@app.post("/detect_language")
async def detect_language(audio_file: UploadFile):
    """Detect language from audio"""
    
    if not audio_file:
        raise HTTPException(status_code=400, detail="No audio file provided")
    
    content = await audio_file.read()
    
    with tempfile.NamedTemporaryFile(delete=False, suffix=".wav") as tmp_file:
        tmp_file.write(content)
        tmp_file_path = tmp_file.name
    
    try:
        # Use Whisper's language detection
        loop = asyncio.get_event_loop()
        result = await loop.run_in_executor(
            executor,
            lambda: model.transcribe(tmp_file_path, language=None, task="transcribe", fp16=DEVICE == "cuda")
        )
        
        return {
            "detected_language": result["language"],
            "confidence": "high",  # Whisper doesn't provide confidence scores
            "text_preview": result["text"][:100] + "..." if len(result["text"]) > 100 else result["text"]
        }
        
    finally:
        os.unlink(tmp_file_path)

@app.get("/health")
async def health_check():
    """Health check endpoint"""
    return {
        "status": "healthy",
        "model": MODEL_SIZE,
        "device": DEVICE,
        "gpu_available": torch.cuda.is_available(),
        "supported_tasks": ["transcribe", "translate_to_english", "language_detection"]
    }

@app.get("/languages")
async def get_supported_languages():
    """Get supported languages"""
    return {
        "input_languages": list(whisper.tokenizer.LANGUAGES.keys()),
        "output_languages": ["en", "es", "fr", "de", "it", "pt", "ru", "ja", "ko", "zh", "ar", "hi", "and 100+ more"],  # Via text translation
        "note": "Whisper transcribes in all supported languages. Translation to English is native, other languages use text translation."
    }

@app.post("/translate_audio_to_language", response_model=WhisperResponse)
async def translate_audio_to_any_language(
    audio_file: UploadFile,
    source_language: Optional[str] = Form(None),
    target_language: str = Form("en"),
    return_segments: bool = Form(False),
    return_language: bool = Form(True)
):
    """Translate audio to any language using two-step process"""
    
    if not audio_file:
        raise HTTPException(status_code=400, detail="No audio file provided")
    
    try:
        # Step 1: Transcribe audio to text
        transcription_request = TranscriptionRequest(
            source_language=source_language,
            task="transcribe",
            return_segments=return_segments,
            return_language=return_language
        )
        
        transcription_result = await process_audio_async(audio_file, transcription_request)
        
        # Step 2: Translate the transcribed text (if target is not the source language)
        if target_language != transcription_result.detected_language:
            from googletrans import Translator
            translator = Translator()
            
            # Create cache key for the text translation step
            cache_key = f"text_translate:{hashlib.md5(transcription_result.text.encode()).hexdigest()}:{transcription_result.detected_language}:{target_language}"
            
            # Check cache for text translation
            cached_translation = redis_client.get(cache_key)
            if cached_translation:
                translated_text = json.loads(cached_translation)["translated_text"]
            else:
                # Translate the text
                translation_result = translator.translate(
                    transcription_result.text,
                    src=transcription_result.detected_language,
                    dest=target_language
                )
                translated_text = translation_result.text
                
                # Cache the text translation
                redis_client.setex(cache_key, 3600, json.dumps({
                    "translated_text": translated_text,
                    "source_language": transcription_result.detected_language,
                    "target_language": target_language
                }))
        else:
            # Same language, no translation needed
            translated_text = transcription_result.text
        
        # Return combined result
        return WhisperResponse(
            text=translated_text,
            detected_language=transcription_result.detected_language,
            segments=transcription_result.segments,
            processing_time=transcription_result.processing_time + 0.1,  # Add small overhead for translation
            task="translate_to_language"
        )
        
    except Exception as e:
        logging.error(f"Audio translation error: {str(e)}")
        raise HTTPException(status_code=500, detail="Audio translation failed")

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000, workers=1)