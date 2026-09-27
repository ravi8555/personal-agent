# NeuroGraph — Personal AI Assistant

A stateful, graph-augmented personal AI assistant that builds a persistent, long-term memory of the user over time. Unlike standard conversational bots whose memory is lost across sessions or compressed into lossy flat summaries, **NeuroGraph** continuously extracts atomic facts, relations, and feedback from dialogue into an evolving property graph powered by **Neo4j**, performs proactive conflict detection and self-correction, dynamically injects relevant running context into the system prompt, and features a clean, isolated frontend UI.

## How It Works (Current App)

Every user message flows through the memory pipeline into the graph, then back into the agent:

```
User message
     ↓
Memory (sliding turn history)
     ↓
BackgroundMemoryProcessor (10-step pipeline, non-blocking)
     ↓
Extraction (summary / facts / relations / feedback)
     ↓
Normalization (entities + predicates normalized)
     ↓
Neo4j (User)-[:PREFERS|:DISLIKES|:LIKES]->(Thing) graph
     ↓
GraphKnowledgeRetriever (relevant subgraph)
     ↓
ContextWatcher (topic-aware injection)
     ↓
Running Context (Current relationship / Historical evidence / Latest evidence)
     ↓
Agent (A: memory, B: context watcher, C: running context → system prompt, D: E2E)
     ↓
LLM (response)
```

### Preference-change loop (conflict resolution)

```
DISLIKES coffee (stored fact)
      ↓
new statement: "I like coffee now"
      ↓
LIKES coffee (extracted)
      ↓
ConflictDetector (LIKES <-> DISLIKES, PREFERS -> DISLIKES)
      ↓
FeedbackEngine (audit trail)
      ↓
SelfCorrectionEngine (supersede stale belief)
      ↓
DISLIKES removed
      ↓
LIKES becomes current knowledge
```

Done so far: A — Agent → Memory ✅ · B — Agent → ContextWatcher ✅ ·
C — Running Context → LLM ✅ · D — Actual Agent E2E ✅ ·
Memory conflict resolution ✅ · Self correction ✅ · Neo4j graph ✅

## Phase-wise Roadmap

| Phase | Name | Scope |
| ----- | ---- | ----- |
| 1 | Intent Engine | Classify each message: Question (`"What is..."`) vs Task (`"Create..."`) vs Conversation (`"I like..."`); route Question → retrieval+LLM, Task → planner, Conversation → memory pipeline |
| 2 | Planning Engine | Multi-step plans from tasks (planner → steps → tool calls) |
| 3 | MCP Tool Layer | Gmail / Calendar / GitHub tools behind one MCP interface |
| 4 | Action + Memory | Execute actions, store results back into the graph |
| 5 | User Preferences | Durable preference model with precedence over generic facts |
| 6 | Proactive Agent | Scheduled nudges from graph state + feedback loop |

Target shape:

```
                         PERSONAL AGENT
                               │
                 ┌─────────────┴─────────────┐
                 │                           │
             INPUT LAYER                 MEMORY ENGINE
                 │                           │
          Intent Detection              Short-term Memory
                 │                           │
             Planner                   Extraction
                 │                           │
                 │                     Normalization
                 │                           │
                 │                        Neo4j
                 │                           │
                 │                     Conflict Detection
                 │                           │
                 │                     Self Correction
                 │                           │
                 │                    Context Retrieval
                 │                           │
                 └─────────────┬─────────────┘
                               ↓
                        Context Builder
                               ↓
                         Decision Engine
                               │
                ┌──────────────┼──────────────┐
                ↓              ↓              ↓
              LLM             MCP          Memory
                │              │
                │        ┌─────┼─────┐
                │        ↓     ↓     ↓
                │      Gmail Calendar GitHub
                │
                └──────────────┬──────────────┘
                               ↓
                            Response
                               ↓
                         Action Result
                               ↓
                         Memory Update
```

---

## Table of Contents

- [Overview](#overview)
- [Architecture & Key Features](#architecture--key-features)
  - [1. Continuous Memory Pipeline](#1-continuous-memory-pipeline)
  - [2. Knowledge Graph & Schema (Neo4j)](#2-knowledge-graph--schema-neo4j)
  - [3. Conflict Detection & Self-Correction](#3-conflict-detection--self-correction)
  - [4. Context Watcher & Dynamic Prompt Injection](#4-context-watcher--dynamic-prompt-injection)
  - [5. Isolated Frontend UI](#5-isolated-frontend-ui)
- [Project Structure](#project-structure)
- [Prerequisites](#prerequisites)
- [Environment Configuration](#environment-configuration)
- [Getting Started](#getting-started)
  - [Backend & Agent Setup](#backend--agent-setup)
  - [Frontend Setup](#frontend-setup)
- [Scripts & Commands](#scripts--commands)
- [Testing & Validation](#testing--validation)
- [License](#license)

---

## Overview

Traditional AI assistants suffer from context window constraints and memory degradation. NeuroGraph decouples conversation from durable storage:

1. **Conversations are transient**, but structured knowledge is **permanent and normalized**.
2. **Background scheduling** extracts memory out-of-band without blocking user chat responses.
3. **Graph-based relations** (`User -[PREFERS]-> Coffee`) replace unstructured text dumps.
4. When preferences or facts change (e.g. switching from tea to coffee), **conflict detection** resolves discrepancies and supersedes stale beliefs while preserving feedback audit trails.
5. In upcoming turns, the **Context Watcher** detects the conversation topic and pulls in relevant subgraphs into the agent's running context.

---

## Architecture & Key Features

```
┌────────────────────────────────────────────────────────┐
│                   NeuroGraph Frontend                  │
│       React 18 + TypeScript + Vite (Isolated UI)       │
│  - Grok-style single-fold chat                         │
│  - Light / Dark theming                                │
│  - Privacy choices & Cookie consent modal              │
│  - Terms of Service & Privacy Policy dialogs           │
└───────────────────────────┬────────────────────────────┘
                            │ (Future API Bridge)
┌───────────────────────────▼────────────────────────────┐
│                    NeuroGraph Core                     │
│               Agent & Execution Runtime                │
│  - AgentBuilder with tool and interceptor support      │
│  - Tool calling execution loop (e.g., Weather, CLI)    │
│  - Interceptor hooks for conversation auditing         │
└─────────────┬───────────────────────────┬──────────────┘
              │                           │
  [Inbound / Outbound turns]   [Context Watcher & Retrieval]
              │                           ▲
┌─────────────▼─────────────┐             │
│  Memory & Processor Queue │             │ (Injects relevant
│  - Sliding turn history   │             │  knowledge graph context)
│  - Background scheduler   │             │
└─────────────┬─────────────┘             │
              │ (Periodic cycle)          │
┌─────────────▼─────────────┐             │
│    Memory Extraction      │             │
│  - Summaries              │             │
│  - Atomic facts           │             │
│  - Normalized relations   │             │
│  - User feedback signals  │             │
└─────────────┬─────────────┘             │
              │                           │
┌─────────────▼─────────────┐             │
│ Conflict Engine & Graph   │             │
│  - Predicate normalization│             │
│  - Conflict detection     │             │
│  - Self-correction        │─────────────┘
│  - Neo4j Property Graph   │
└───────────────────────────┘

### 1. Continuous Memory Pipeline
- **Memory Processor & Scheduler**: Conversation turns are collected in-memory. A background scheduler periodically passes unprocessed turns through an LLM extraction pipeline.
- **Extraction Artifacts**: Produces conversation summaries, discrete atomic facts, structured subject-predicate-object relations, and explicit user feedback markers (likes/dislikes, corrections).

### 2. Knowledge Graph & Schema (Neo4j)
Knowledge is mapped into a graph schema (`docs/GRAPH_SCHEMA.md`):
- **Nodes**:
  - `(:Entity {name, type})` — People, places, tools, and concepts (keyed by normalized lowercase representation).
  - `(:Fact {text, extractedAt})` — Atomic factual statements.
  - `(:Summary {summaryId, text})` — Extracted conversation block summaries.
  - `(:Feedback {feedbackId, feedbackType, details})` — User feedback signals.
- **Relationships**:
  - `(:Entity)-[:RELATES_TO {predicate, confidence, extractedAt}]->(:Entity)`
  - `(:Fact)-[:ABOUT]->(:Entity)`
  - `(:Summary)-[:ABOUT]->(:Entity)`
  - `(:Feedback)-[:ABOUT]->(:Entity)`
- **Normalization**: Canonicalizes messy natural language predicates (e.g. `"enjoys"`, `"likes"`, `"fancies"` → `LIKES`; `"lives in"` → `LIVES_IN`).

### 3. Conflict Detection & Self-Correction
- Checks incoming normalized relations against existing facts and relationships in Neo4j.
- Detects contradictions (e.g., opposing predicates or mutually exclusive attributes like `User LIKES Tea` vs `User LIKES Coffee`).
- Applies self-correction rules to retire or supersede outdated relations while retaining historical context and feedback.

### 4. Context Watcher & Dynamic Prompt Injection
- Evaluates the user's latest inputs to detect active conversation topics and referenced entities.
- Traverses the Neo4j graph to fetch relevant facts and relations.
- Generates a concise `RunningContext` block injected directly into the LLM system prompt.

### 5. Isolated Frontend UI
- Located in `frontend/`, designed as a clean, single-fold, scroll-free conversational experience.
- Complete separation of concerns: runs standalone with a mock preview echo, ready to hook into backend endpoints.
- Features: Light/Dark theming, Cookie Banner toast, Privacy Choices modal with per-category controls, and Legal Modals for Terms and Privacy.

---

## Project Structure

```
Personal-Agent/
├── .env.example               # Template for environment configuration
├── README.md                  # Project overview and guide
├── package.json               # Backend / Agent SDK dependencies & scripts
├── tsconfig.json              # TypeScript configuration (excluding frontend)
├── docs/
│   └── GRAPH_SCHEMA.md        # Formal Neo4j schema specification & DDL
├── src/
│   ├── index.ts               # Demo entry point demonstrating Agent run & memory cycle
│   ├── app/
│   │   ├── agent.ts           # Core Agent & AgentBuilder classes
│   │   ├── backgroundMemoryProcessor.ts # Out-of-band memory queue
│   │   ├── backgroundScheduler.ts       # Periodic background tick runner
│   │   ├── config.ts          # Prompts and system configuration
│   │   ├── conflictDetector.ts# Contradiction and conflict detection
│   │   ├── contextWatcher.ts  # Topic analysis and context watching
│   │   ├── feedbackEngine.ts  # Extraction and tracking of user feedback
│   │   ├── graphCypher.ts     # Cypher queries for Neo4j operations
│   │   ├── graphNormalization.ts # Canonicalization for predicates & entities
│   │   ├── graphRetrieval.ts  # Graph traversal and retrieval algorithms
│   │   ├── graphSchema.ts     # Schema definitions and DDL initialization
│   │   ├── graphStore.ts      # Neo4j database driver and session management
│   │   ├── memory.ts          # Conversation turn history management
│   │   ├── memoryExtraction.ts# LLM-based structured extraction
│   │   ├── memoryProcessor.ts # Pipeline orchestrator for turn extraction
│   │   ├── memoryScheduler.ts # Scheduled processor trigger
│   │   ├── runningContext.ts  # System prompt context builder
│   │   └── selfCorrection.ts  # Graph update logic for resolving conflicts
│   └── tests/                 # Unit, integration, and E2E test suites
└── frontend/                  # Isolated React UI
    ├── package.json           # Frontend dependencies & scripts
    ├── vite.config.ts         # Vite bundler configuration
    ├── index.html             # Application HTML shell
    ├── public/
    │   └── assets/            # Static assets (SVG logo, etc.)
    └── src/
        ├── main.tsx           # React root
        ├── App.tsx            # Main layout wrapper
        ├── styles.css         # Themed CSS system (Light/Dark tokens)
        ├── components/        # Header, Logo, ThemeToggle, CookieBanner, Modals
        ├── context/           # ThemeContext, ConsentContext
        └── pages/             # Home (Chat), PrivacyPolicy, Terms
```

```

---

## Prerequisites

- **Node.js**: v18.0.0 or higher (v20+ recommended)
- **npm**: v9.0.0 or higher
- **Neo4j Database**: local Docker `neo4j:5-community` (see `docker-compose.yml`) or a cloud-hosted Neo4j AuraDB instance
- **Docker**: for the local `neo4j-community` container (ports 7474 browser, 7687 bolt)
- **OpenAI API Key**: Required for memory extraction and response generation

---

## Environment Configuration

Create a `.env` file in the root directory:

```bash
cp .env.example .env
```

For **local Docker** development, copy the local template instead:

```bash
cp .env.local .env
# .env.local points at bolt://localhost:7687 (neo4j/neurograph-local)
```

Set the appropriate credentials:

```env
# Neo4j Connection
NEO4J_URI=neo4j+s://<your-database-id>.databases.neo4j.io
NEO4J_USER=neo4j
NEO4J_PASSWORD=<your-database-password>
NEO4J_DATABASE=neo4j

# OpenAI API Key
OPENAI_API_KEY=sk-...
```

---

## Getting Started

### Backend & Agent Setup

1. **Install backend dependencies:**
   ```bash
   npm install
   ```

2. **Verify TypeScript compilation:**
   ```bash
   npm run typecheck
   npm run build
   ```

3. **Run the agent demo:**
   ```bash
   node --env-file=.env dist/index.js
   ```

### Frontend Setup

1. **Navigate to the frontend directory and install dependencies:**
   ```bash
   cd frontend
   npm install
   ```

2. **Start the local development server:**
   ```bash
   npm run dev
   ```
   Open `http://localhost:5173` in your browser.

3. **Build the frontend for production:**
   ```bash
   npm run build
   ```
   The compiled bundle will be output to `frontend/dist/`.

---

## Scripts & Commands

### Root (Backend / SDK)

| Command | Description |
|---|---|
| `npm run build` | Compiles TypeScript sources (`src/`) to JavaScript (`dist/`) |
| `npm run typecheck` | Type-checks the backend codebase using `tsconfig.json` |
| `npm run test:connection` | Tests Neo4j connectivity using credentials in `.env` |
| `npm run test:neo4j` | Runs the Neo4j memory store test suite |

### Frontend (`frontend/`)

| Command | Description |
|---|---|
| `npm run dev` | Launches the Vite dev server with hot module replacement (HMR) |
| `npm run build` | Runs typecheck (`tsc --noEmit`) and compiles the production bundle |
| `npm run typecheck` | Validates TypeScript types across all React components |
| `npm run preview` | Serves the production build locally for verification |

---

## Testing & Validation

Test scripts for backend subsystems are located in `src/tests/` and can be run using Node's loader with tsx:

- **Neo4j Connectivity:**
  ```bash
  npm run test:connection
  ```
- **Store Operations:**
  ```bash
  npm run test:neo4j
  ```
- **Context Watcher Test:**
  ```bash
  node --env-file=.env --loader tsx src/tests/context-watacher-test.ts
  ```
- **Conflict Detection & Self-Correction:**
  ```bash
  node --env-file=.env --loader tsx src/tests/confict-detect-test.ts
  node --env-file=.env --loader tsx src/tests/self-correction-neo4j-test.ts
  ```
- **End-to-End Memory Lifecycle:**
  ```bash
  node --env-file=.env --loader tsx src/tests/final-memory-e2e-test.ts
  ```

---

## License

ISC

