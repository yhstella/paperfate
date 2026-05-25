#!/usr/bin/env python
"""FateCore v0.1 — HTTP API server (FastAPI).

사용:
    pip install fastapi uvicorn
    python scripts/serve-fatecore.py
    # → http://localhost:8000/api/forecast (POST)
    # → http://localhost:8000/docs (Swagger UI)

Test:
    curl -X POST http://localhost:8000/api/forecast \\
      -H "Content-Type: application/json" \\
      -d '{"abstract": "...", "year": 2025}'
"""
import sys
import os
from pathlib import Path
from contextlib import asynccontextmanager

# Make script importable: add scripts/ to sys.path
sys.path.insert(0, str(Path(__file__).parent))

# Import predict module
import importlib.util
spec = importlib.util.spec_from_file_location("predict_fatecore", Path(__file__).parent / "predict-fatecore.py")
_pf = importlib.util.module_from_spec(spec)
spec.loader.exec_module(_pf)

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import Optional

@asynccontextmanager
async def lifespan(app: FastAPI):
    print("Loading FateCore v0.1 models...")
    app.state.models = _pf.load_models()
    print("✓ Ready: http://localhost:8000/docs")
    yield


app = FastAPI(title="FateCore v0.1 API", version="0.1.0", lifespan=lifespan)

# CORS — allow paperfate.com and localhost
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "https://paperfate.com",
        "https://www.paperfate.com",
        "http://localhost:5180",  # vite dev
        "http://localhost:5173",
        "http://localhost:3000",
    ],
    allow_credentials=False,
    allow_methods=["POST", "OPTIONS"],
    allow_headers=["*"],
)


class ForecastRequest(BaseModel):
    abstract: str
    year: Optional[int] = None
    target_journal: Optional[str] = None
    mode: Optional[str] = "abstract"  # "abstract" (Q100) or "full" (Q500)


class ForecastResponse(BaseModel):
    fatecore_version: str
    predictions: dict
    confidence_note: str


@app.get("/")
def root():
    return {
        "service": "FateCore v0.1",
        "endpoints": ["/api/forecast (POST)", "/docs (interactive)"],
        "model": {
            "version": "v0.1-paper-only",
            "trained_on": "219,264 papers",
            "metrics": {
                "jcr_jif_R2": 0.308,
                "icite_rcr_R2": 0.312,
                "citations_log_R2": 0.862,
            },
        },
    }


@app.post("/api/forecast", response_model=ForecastResponse)
def forecast(req: ForecastRequest):
    if not req.abstract or len(req.abstract.strip()) < 50:
        raise HTTPException(status_code=400, detail="abstract must be at least 50 characters")
    try:
        result = _pf.predict(
            text=req.abstract,
            year=req.year,
            target_journal=req.target_journal,
        )
        return result
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/health")
def health():
    return {"status": "ok", "models_loaded": len(app.state.models[0]) if hasattr(app.state, "models") else 0}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(
        app,
        host="0.0.0.0",
        port=int(os.environ.get("PORT", 8000)),
        log_level="info",
    )
