# whisper-service/Dockerfile
FROM python:3.11-slim

# Install system dependencies including build tools
RUN apt-get update && apt-get install -y \
    ffmpeg \
    curl \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

# Set working directory
WORKDIR /app

# Copy requirements
COPY requirements.txt .

# Set environment variables to prevent NumPy issues
ENV PYTHONUNBUFFERED=1
ENV PIP_NO_CACHE_DIR=1
ENV PIP_DISABLE_PIP_VERSION_CHECK=1

# Install Python dependencies with specific NumPy version first
RUN pip install --upgrade pip setuptools wheel && \
    pip install "numpy>=1.21.0,<2.0.0" && \
    pip install --no-deps torch==2.1.0 torchaudio==2.1.0 && \
    pip install -r requirements.txt

# Copy application code
COPY . .

# Create cache directory
RUN mkdir -p /root/.cache/whisper

# Expose port
EXPOSE 8000

# Run the application
CMD ["python", "app.py"]