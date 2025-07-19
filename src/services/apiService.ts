// apiService.ts - API service for communicating with whisper-service
import { getApiConfig, API_ENDPOINTS, ApiConfig } from '../config';
import { APIError } from '../types';

export interface WhisperResponse {
  text: string;
  detected_language?: string;
  segments?: any[];
  processing_time: number;
  task: string;
}

export interface TranslationResponse {
  translated_text: string;
  source_language: string;
  target_language: string;
  detected_language: string;
  processing_time: number;
}

export interface HealthResponse {
  status: string;
  model: string;
  device: string;
  gpu_available: boolean;
  supported_tasks: string[];
}

export class ApiService {
  private config: ApiConfig | null = null;
  private requestQueue: Map<string, Promise<any>> = new Map();
  
  private async getConfig(): Promise<ApiConfig> {
    if (!this.config) {
      this.config = await getApiConfig();
    }
    return this.config;
  }

  async healthCheck(): Promise<HealthResponse> {
    try {
      const config = await this.getConfig();
      const response = await this.makeRequest('GET', config.healthCheckUrl);
      return response as HealthResponse;
    } catch (error) {
      throw new APIError('Health check failed', 0, error);
    }
  }

  async transcribeAudio(
    audioBlob: Blob,
    sourceLanguage: string = 'auto',
    returnSegments: boolean = false
  ): Promise<WhisperResponse> {
    const formData = new FormData();
    formData.append('audio_file', audioBlob, 'audio.webm');
    formData.append('source_language', sourceLanguage === 'auto' ? '' : sourceLanguage);
    formData.append('return_segments', returnSegments.toString());
    formData.append('return_language', 'true');

    try {
      const config = await this.getConfig();
      const response = await this.makeRequest(
        'POST',
        `${config.whisperServiceUrl}${API_ENDPOINTS.TRANSCRIBE}`,
        formData
      );
      return response as WhisperResponse;
    } catch (error) {
      throw new APIError('Transcription failed', 0, error);
    }
  }

  async translateAudioToLanguage(
    audioBlob: Blob,
    targetLanguage: string,
    sourceLanguage: string = 'auto',
    returnSegments: boolean = false
  ): Promise<WhisperResponse> {
    const formData = new FormData();
    formData.append('audio_file', audioBlob, 'audio.webm');
    formData.append('source_language', sourceLanguage === 'auto' ? '' : sourceLanguage);
    formData.append('target_language', targetLanguage);
    formData.append('return_segments', returnSegments.toString());
    formData.append('return_language', 'true');

    try {
      const config = await this.getConfig();
      const response = await this.makeRequest(
        'POST',
        `${config.whisperServiceUrl}${API_ENDPOINTS.TRANSLATE_AUDIO_TO_LANGUAGE}`,
        formData
      );
      return response as WhisperResponse;
    } catch (error) {
      throw new APIError('Audio translation failed', 0, error);
    }
  }

  async translateText(
    text: string,
    sourceLanguage: string,
    targetLanguage: string
  ): Promise<TranslationResponse> {
    const requestData = {
      text,
      source_language: sourceLanguage,
      target_language: targetLanguage
    };

    try {
      const config = await this.getConfig();
      const response = await this.makeRequest(
        'POST',
        `${config.whisperServiceUrl}${API_ENDPOINTS.TRANSLATE_TEXT}`,
        JSON.stringify(requestData),
        {
          'Content-Type': 'application/json'
        }
      );
      return response as TranslationResponse;
    } catch (error) {
      throw new APIError('Text translation failed', 0, error);
    }
  }

  async detectLanguage(audioBlob: Blob): Promise<{
    detected_language: string;
    confidence: string;
    text_preview: string;
  }> {
    const formData = new FormData();
    formData.append('audio_file', audioBlob, 'audio.webm');

    try {
      const config = await this.getConfig();
      const response = await this.makeRequest(
        'POST',
        `${config.whisperServiceUrl}${API_ENDPOINTS.DETECT_LANGUAGE}`,
        formData
      );
      return response;
    } catch (error) {
      throw new APIError('Language detection failed', 0, error);
    }
  }

  private async makeRequest(
    method: string,
    url: string,
    body?: FormData | string,
    headers?: Record<string, string>
  ): Promise<any> {
    // Create a unique key for request deduplication
    const requestKey = `${method}:${url}:${body ? body.toString().slice(0, 100) : ''}`;
    
    // Check if the same request is already in progress
    if (this.requestQueue.has(requestKey)) {
      return this.requestQueue.get(requestKey);
    }

    const requestPromise = this.executeRequest(method, url, body, headers);
    this.requestQueue.set(requestKey, requestPromise);

    try {
      const result = await requestPromise;
      this.requestQueue.delete(requestKey);
      return result;
    } catch (error) {
      this.requestQueue.delete(requestKey);
      throw error;
    }
  }

  private async executeRequest(
    method: string,
    url: string,
    body?: FormData | string,
    headers?: Record<string, string>
  ): Promise<any> {
    const controller = new AbortController();
    const config = await this.getConfig();
    const timeoutId = setTimeout(() => controller.abort(), config.requestTimeout);

    try {
      const requestInit: RequestInit = {
        method,
        signal: controller.signal,
        headers: headers || {}
      };

      if (body) {
        requestInit.body = body;
      }

      const response = await fetch(url, requestInit);
      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorText = await response.text();
        throw new APIError(
          `API request failed: ${response.status} ${response.statusText}`,
          response.status,
          errorText
        );
      }

      const contentType = response.headers.get('content-type');
      if (contentType && contentType.includes('application/json')) {
        return await response.json();
      } else {
        return await response.text();
      }
    } catch (error) {
      clearTimeout(timeoutId);
      
      if (error instanceof APIError) {
        throw error;
      }

      if (typeof error === 'object' && error !== null && 'name' in error && (error as any).name === 'AbortError') {
        throw new APIError('Request timeout', 408, 'Request was aborted due to timeout');
      }

      let errorMessage = 'Unknown error';
      if (typeof error === 'object' && error !== null && 'message' in error && typeof (error as any).message === 'string') {
        errorMessage = (error as any).message;
      }
      throw new APIError('Network error', 0, errorMessage);
    }
  }

  // Retry mechanism for failed requests
  async retryRequest<T>(
    requestFn: () => Promise<T>,
    maxRetries?: number
  ): Promise<T> {
    const config = await this.getConfig();
    const actualMaxRetries = maxRetries ?? config.maxRetries;
    let lastError: Error;

    for (let attempt = 0; attempt <= actualMaxRetries; attempt++) {
      try {
        return await requestFn();
      } catch (error) {
        lastError = error as Error;
        
        if (attempt === actualMaxRetries) {
          break;
        }

        // Exponential backoff
        const delay = Math.pow(2, attempt) * 1000;
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }

    throw lastError!;
  }

  // Update API configuration (for switching between local and cloud)
  updateConfig(newConfig: Partial<ApiConfig>) {
    if (!this.config) {
      throw new Error('Cannot update config before initial config is loaded.');
    }
    // Only overwrite defined properties
    this.config = {
      ...this.config,
      ...Object.fromEntries(
        Object.entries(newConfig).filter(([_, v]) => v !== undefined)
      )
    } as ApiConfig;
  }
}

// Singleton instance
export const apiService = new ApiService();
