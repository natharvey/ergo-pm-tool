FROM python:3.12-slim

# Set working directory inside the container
WORKDIR /app

# Install dependencies first (cached as a separate layer)
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy the rest of the application
COPY . .

# Expose the port uvicorn will listen on
EXPOSE 8000

# Run the app
CMD ["python", "-m", "uvicorn", "backend.main:app", "--host", "0.0.0.0", "--port", "8000"]
