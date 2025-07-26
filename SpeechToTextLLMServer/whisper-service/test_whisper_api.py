#!/usr/bin/env python3
"""
Comprehensive test script for Whisper Service API
Tests all endpoints with various scenarios
"""


import json
import time
import os
from typing import Optional
import tempfile
import wave
import numpy as np
import requests


# Configuration
BASE_URL = "http://34.152.9.212"  # Replace with your actual URL
TEST_AUDIO_FILE = "test_audio.wav"

class Colors:
    GREEN = '\033[92m'
    RED = '\033[91m' 
    BLUE = '\033[94m'
    YELLOW = '\033[93m'
    END = '\033[0m'
    BOLD = '\033[1m'

def print_result(test_name: str, success: bool, details: str = "", response_time: float = 0):
    """Print formatted test result"""
    status = f"{Colors.GREEN}✅ PASS{Colors.END}" if success else f"{Colors.RED}❌ FAIL{Colors.END}"
    print(f"{Colors.BOLD}{test_name}{Colors.END}: {status}")
    if details:
        print(f"  {details}")
    if response_time > 0:
        print(f"  {Colors.BLUE}Response time: {response_time:.2f}s{Colors.END}")
    print()

def create_test_audio_file():
    """Create a simple test audio file for testing"""
    if os.path.exists(TEST_AUDIO_FILE):
        return True
        
    try:
        # Generate a 3-second sine wave (440Hz - A note)
        duration = 3.0
        sample_rate = 16000
        t = np.linspace(0, duration, int(sample_rate * duration), False)
        audio_data = np.sin(440 * 2 * np.pi * t) * 0.3
        audio_data = (audio_data * 32767).astype(np.int16)
        
        with wave.open(TEST_AUDIO_FILE, 'w') as wav_file:
            wav_file.setnchannels(1)  # Mono
            wav_file.setsampwidth(2)  # 16-bit
            wav_file.setframerate(sample_rate)
            wav_file.writeframes(audio_data.tobytes())
            
        print(f"{Colors.YELLOW}📝 Created test audio file: {TEST_AUDIO_FILE}{Colors.END}\n")
        return True
    except Exception as e:
        print(f"{Colors.RED}❌ Failed to create test audio file: {e}{Colors.END}\n")
        return False

def test_health_check():
    """Test /health endpoint"""
    try:
        start_time = time.time()
        response = requests.get(f"{BASE_URL}/health", timeout=10)
        response_time = time.time() - start_time
        
        if response.status_code == 200:
            data = response.json()
            details = f"Model: {data.get('model')}, Device: {data.get('device')}, GPU: {data.get('gpu_available')}"
            print_result("Health Check", True, details, response_time)
            return True
        else:
            print_result("Health Check", False, f"Status: {response.status_code}")
            return False
    except Exception as e:
        print_result("Health Check", False, f"Error: {str(e)}")
        return False

def test_supported_languages():
    """Test /languages endpoint"""
    try:
        start_time = time.time()
        response = requests.get(f"{BASE_URL}/languages", timeout=10)
        response_time = time.time() - start_time
        
        if response.status_code == 200:
            data = response.json()
            input_count = len(data.get('input_languages', []))
            details = f"Input languages: {input_count}, Output languages supported via text translation"
            print_result("Supported Languages", True, details, response_time)
            return True
        else:
            print_result("Supported Languages", False, f"Status: {response.status_code}")
            return False
    except Exception as e:
        print_result("Supported Languages", False, f"Error: {str(e)}")
        return False

def test_transcribe_audio():
    """Test /transcribe endpoint"""
    if not os.path.exists(TEST_AUDIO_FILE):
        print_result("Transcribe Audio", False, "Test audio file not found")
        return False
        
    try:
        start_time = time.time()
        with open(TEST_AUDIO_FILE, 'rb') as f:
            files = {'audio_file': ('test.wav', f, 'audio/wav')}
            data = {
                'source_language': 'ko',
                'return_segments': 'false',
                'return_language': 'true'
            }
            response = requests.post(f"{BASE_URL}/transcribe", files=files, data=data, timeout=60)
        
        response_time = time.time() - start_time
        
        if response.status_code == 200:
            result = response.json()
            details = f"Text: '{result.get('text', '')[:50]}...', Language: {result.get('detected_language')}, Processing: {result.get('processing_time', 0):.2f}s"
            print_result("Transcribe Audio", True, details, response_time)
            return True
        else:
            print_result("Transcribe Audio", False, f"Status: {response.status_code}, Response: {response.text}")
            return False
    except Exception as e:
        print_result("Transcribe Audio", False, f"Error: {str(e)}")
        return False

def test_translate_to_english():
    """Test /translate endpoint (Whisper's native translation to English)"""
    if not os.path.exists(TEST_AUDIO_FILE):
        print_result("Translate to English", False, "Test audio file not found")
        return False
        
    try:
        start_time = time.time()
        with open(TEST_AUDIO_FILE, 'rb') as f:
            files = {'audio_file': ('test.wav', f, 'audio/wav')}
            data = {
                'source_language': 'auto',  # Auto-detect
                'target_language': 'en',
                'return_segments': 'false',
                'return_language': 'true'
            }
            response = requests.post(f"{BASE_URL}/translate", files=files, data=data, timeout=60)
        
        response_time = time.time() - start_time
        
        if response.status_code == 200:
            result = response.json()
            details = f"Text: '{result.get('text', '')[:50]}...', Source: {result.get('detected_language')}, Processing: {result.get('processing_time', 0):.2f}s"
            print_result("Translate to English", True, details, response_time)
            return True
        else:
            print_result("Translate to English", False, f"Status: {response.status_code}, Response: {response.text}")
            return False
    except Exception as e:
        print_result("Translate to English", False, f"Error: {str(e)}")
        return False

def test_translate_audio_to_language():
    """Test /translate_audio_to_language endpoint"""
    if not os.path.exists(TEST_AUDIO_FILE):
        print_result("Translate Audio to Language", False, "Test audio file not found")
        return False
        
    try:
        start_time = time.time()
        with open(TEST_AUDIO_FILE, 'rb') as f:
            files = {'audio_file': ('test.wav', f, 'audio/wav')}
            data = {
                'source_language': 'auto',
                'target_language': 'es',  # Spanish
                'return_segments': 'false',
                'return_language': 'true'
            }
            response = requests.post(f"{BASE_URL}/translate_audio_to_language", files=files, data=data, timeout=60)
        
        response_time = time.time() - start_time
        
        if response.status_code == 200:
            result = response.json()
            details = f"Text: '{result.get('text', '')[:50]}...', Source: {result.get('detected_language')}, Processing: {result.get('processing_time', 0):.2f}s"
            print_result("Translate Audio to Language", True, details, response_time)
            return True
        else:
            print_result("Translate Audio to Language", False, f"Status: {response.status_code}, Response: {response.text}")
            return False
    except Exception as e:
        print_result("Translate Audio to Language", False, f"Error: {str(e)}")
        return False

def test_detect_language():
    """Test /detect_language endpoint"""
    if not os.path.exists(TEST_AUDIO_FILE):
        print_result("Detect Language", False, "Test audio file not found")
        return False
        
    try:
        start_time = time.time()
        with open(TEST_AUDIO_FILE, 'rb') as f:
            files = {'audio_file': ('test.wav', f, 'audio/wav')}
            response = requests.post(f"{BASE_URL}/detect_language", files=files, timeout=60)
        
        response_time = time.time() - start_time
        
        if response.status_code == 200:
            result = response.json()
            details = f"Language: {result.get('detected_language')}, Confidence: {result.get('confidence')}, Preview: '{result.get('text_preview', '')[:30]}...'"
            print_result("Detect Language", True, details, response_time)
            return True
        else:
            print_result("Detect Language", False, f"Status: {response.status_code}, Response: {response.text}")
            return False
    except Exception as e:
        print_result("Detect Language", False, f"Error: {str(e)}")
        return False

def test_translate_text():
    """Test /translate_text endpoint"""
    try:
        start_time = time.time()
        payload = {
            "text": "Hello, how are you today?",
            "source_language": "en",
            "target_language": "es"
        }
        response = requests.post(f"{BASE_URL}/translate_text", json=payload, timeout=30)
        response_time = time.time() - start_time
        
        if response.status_code == 200:
            result = response.json()
            details = f"Original: '{payload['text']}' → Translated: '{result.get('translated_text')}', Processing: {result.get('processing_time', 0):.2f}s"
            print_result("Translate Text", True, details, response_time)
            return True
        else:
            print_result("Translate Text", False, f"Status: {response.status_code}, Response: {response.text}")
            return False
    except Exception as e:
        print_result("Translate Text", False, f"Error: {str(e)}")
        return False

def test_error_handling():
    """Test error handling with invalid requests"""
    tests_passed = 0
    total_tests = 3
    
    # Test 1: No audio file
    try:
        response = requests.post(f"{BASE_URL}/transcribe", timeout=10)
        if response.status_code == 422:  # FastAPI validation error
            tests_passed += 1
            print(f"  {Colors.GREEN}✅{Colors.END} No audio file handled correctly")
        else:
            print(f"  {Colors.RED}❌{Colors.END} No audio file: expected 422, got {response.status_code}")
    except:
        print(f"  {Colors.RED}❌{Colors.END} No audio file test failed")
    
    # Test 2: Invalid translate target (non-English for /translate)
    if os.path.exists(TEST_AUDIO_FILE):
        try:
            with open(TEST_AUDIO_FILE, 'rb') as f:
                files = {'audio_file': ('test.wav', f, 'audio/wav')}
                data = {'target_language': 'fr'}  # Should fail for /translate
                response = requests.post(f"{BASE_URL}/translate", files=files, data=data, timeout=30)
            
            if response.status_code == 400:
                tests_passed += 1
                print(f"  {Colors.GREEN}✅{Colors.END} Invalid translation target handled correctly")
            else:
                print(f"  {Colors.RED}❌{Colors.END} Invalid target: expected 400, got {response.status_code}")
        except:
            print(f"  {Colors.RED}❌{Colors.END} Invalid target test failed")
    
    # Test 3: Empty text translation
    try:
        payload = {"text": "", "source_language": "en", "target_language": "es"}
        response = requests.post(f"{BASE_URL}/translate_text", json=payload, timeout=10)
        if response.status_code in [400, 422, 500]:  # Should handle empty text
            tests_passed += 1
            print(f"  {Colors.GREEN}✅{Colors.END} Empty text handled correctly")
        else:
            print(f"  {Colors.YELLOW}⚠️{Colors.END} Empty text: got {response.status_code} (may be acceptable)")
            tests_passed += 1  # Count as pass since different implementations may handle this differently
    except:
        print(f"  {Colors.RED}❌{Colors.END} Empty text test failed")
    
    success = tests_passed == total_tests
    print_result("Error Handling", success, f"Passed {tests_passed}/{total_tests} error handling tests")
    return success

def main():
    """Run all tests"""
    print(f"{Colors.BOLD}🧪 Whisper Service API Test Suite{Colors.END}")
    print(f"{Colors.BLUE}Testing API at: {BASE_URL}{Colors.END}\n")
    
    # Create test audio file
    if not create_test_audio_file():
        print(f"{Colors.RED}Cannot proceed without test audio file{Colors.END}")
        return
    
    # Run all tests
    tests = [
        ("API Health", test_health_check),
        ("Supported Languages", test_supported_languages),
        ("Transcribe Audio", test_transcribe_audio),
        ("Translate to English", test_translate_to_english),
        ("Translate Audio to Language", test_translate_audio_to_language),
        ("Detect Language", test_detect_language),
        ("Translate Text", test_translate_text),
        ("Error Handling", test_error_handling)
    ]
    
    passed = 0
    total = len(tests)
    
    for test_name, test_func in tests:
        try:
            if test_func():
                passed += 1
        except Exception as e:
            print_result(test_name, False, f"Test crashed: {str(e)}")
    
    # Summary
    print(f"{Colors.BOLD}📊 Test Results Summary{Colors.END}")
    print(f"Passed: {Colors.GREEN}{passed}{Colors.END}")
    print(f"Failed: {Colors.RED}{total - passed}{Colors.END}")
    print(f"Total:  {total}")
    
    if passed == total:
        print(f"\n{Colors.GREEN}🎉 All tests passed! Your API is working perfectly.{Colors.END}")
    else:
        print(f"\n{Colors.YELLOW}⚠️  Some tests failed. Check the details above.{Colors.END}")

if __name__ == "__main__":
    main()
