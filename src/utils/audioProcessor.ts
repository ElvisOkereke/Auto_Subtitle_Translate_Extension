// audioProcessor.ts - Real-time audio processing utilities
import { AUDIO_CONFIG } from '../config';

export class AudioProcessor {
  private audioContext: AudioContext | null = null;
  private mediaRecorder: MediaRecorder | null = null;
  private audioBuffer: Float32Array[] = [];
  private isProcessing = false;
  private processingInterval: number | null = null;
  private onAudioChunk: ((audioData: Blob) => void) | null = null;

  constructor() {
    this.setupAudioContext();
  }

  private setupAudioContext() {
    const AudioContext = window.AudioContext || (window as any).webkitAudioContext;
    this.audioContext = new AudioContext();
  }

  async startProcessing(stream: MediaStream, onAudioChunk: (audioData: Blob) => void): Promise<void> {
    this.onAudioChunk = onAudioChunk;
    
    try {
      // Create MediaRecorder with optimal settings for real-time processing
      const options = {
        mimeType: 'audio/webm;codecs=opus',
        audioBitsPerSecond: 16000 // Lower bitrate for real-time
      };

      this.mediaRecorder = new MediaRecorder(stream, options);
      
      // Configure for small chunks
      this.mediaRecorder.addEventListener('dataavailable', (event) => {
        if (event.data.size > 0) {
          this.handleAudioChunk(event.data);
        }
      });

      this.mediaRecorder.addEventListener('start', () => {
        console.log('Audio recording started');
      });

      this.mediaRecorder.addEventListener('stop', () => {
        console.log('Audio recording stopped');
      });

      // Start recording with small time slices for real-time processing
      this.mediaRecorder.start(AUDIO_CONFIG.PROCESSING_INTERVAL);
      this.isProcessing = true;

    } catch (error) {
      console.error('Failed to start audio processing:', error);
      throw error;
    }
  }

  private handleAudioChunk(audioBlob: Blob) {
    if (this.onAudioChunk && audioBlob.size > 0) {
      // Only process if we have enough audio data
      if (audioBlob.size > 1000) { // Minimum 1KB
        this.onAudioChunk(audioBlob);
      }
    }
  }

  stopProcessing() {
    this.isProcessing = false;
    
    if (this.processingInterval) {
      clearInterval(this.processingInterval);
      this.processingInterval = null;
    }

    if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
      this.mediaRecorder.stop();
    }

    this.audioBuffer = [];
  }

  cleanup() {
    this.stopProcessing();
    
    if (this.audioContext && this.audioContext.state !== 'closed') {
      this.audioContext.close();
    }
  }

  // Convert audio blob to the format expected by whisper-service
  async convertAudioForAPI(audioBlob: Blob): Promise<Blob> {
    try {
      // For real-time processing, we'll send the audio blob directly
      // The whisper-service can handle various audio formats
      return audioBlob;
    } catch (error) {
      console.error('Audio conversion failed:', error);
      throw error;
    }
  }

  // Detect if audio contains speech (basic silence detection)
  async detectSpeech(audioBlob: Blob): Promise<boolean> {
    try {
      if (!this.audioContext) return true; // Assume speech if we can't detect

      const arrayBuffer = await audioBlob.arrayBuffer();
      const audioBuffer = await this.audioContext.decodeAudioData(arrayBuffer);
      
      const channelData = audioBuffer.getChannelData(0);
      let sum = 0;
      
      for (let i = 0; i < channelData.length; i++) {
        sum += Math.abs(channelData[i]);
      }
      
      const average = sum / channelData.length;
      return average > AUDIO_CONFIG.SILENCE_THRESHOLD;
    } catch (error) {
      console.error('Speech detection failed:', error);
      return true; // Assume speech on error
    }
  }
}

export class AudioChunkBuffer {
  private chunks: Blob[] = [];
  private maxChunks: number;

  constructor(maxChunks = 10) {
    this.maxChunks = maxChunks;
  }

  addChunk(chunk: Blob) {
    this.chunks.push(chunk);
    
    // Keep only the most recent chunks
    if (this.chunks.length > this.maxChunks) {
      this.chunks.shift();
    }
  }

  async getCombinedChunk(): Promise<Blob> {
    if (this.chunks.length === 0) {
      throw new Error('No audio chunks available');
    }

    return new Blob(this.chunks, { type: 'audio/webm' });
  }

  clear() {
    this.chunks = [];
  }

  getChunkCount(): number {
    return this.chunks.length;
  }
}
