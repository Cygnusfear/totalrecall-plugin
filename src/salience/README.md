# Salience Scoring Module

This module implements memory consolidation through salience scoring, inspired by how the brain processes memories during sleep ("dreaming").

## Problem

Not all memories are equally important. A synthesis graph can accumulate thousands of nodes, but:
- Some represent critical decisions or breakthroughs
- Others are routine, repeated patterns
- Retrieval should prioritize what matters most

## Solution

Salience scoring assigns importance values (0.0-2.0) to each synthesis node based on multiple signals:

### High Salience Signals
- **Novel**: First occurrence of a pattern or concept
- **Emotional**: Contains emotional markers (excited, frustrated, breakthrough, etc.)
- **Consequential**: Led to significant changes or decisions
- **User-marked**: Explicitly marked as important by user
- **Pattern-breaking**: Contradicts or revises existing knowledge
- **Highly connected**: Many edges to other nodes

### Low Salience Signals
- **Routine**: Repeated similar events
- **Expected**: Follows established patterns
- **Stale**: Not accessed for a long time
- **Isolated**: Few connections to other nodes

## Formula

```
salience = (
  inverse_frequency * 0.25 +
  emotional_weight * 0.20 +
  novelty * 0.15 +
  consequence * 0.15 +
  recency * 0.10 +
  user_marked * 0.10 +
  node_type * 0.05
) * connection_weight
```

Final score is clamped to [0.1, 2.0] range.

## Dreaming Passes

Background consolidation runs periodically:

| Pass Type | Frequency | Purpose |
|-----------|-----------|---------|
| Quick | Hourly | Update recently modified nodes |
| Full | Daily | Recalculate all salience scores |
| Decay | Weekly | Apply decay to routine nodes |

## Integration

### Retrieval Scoring
```typescript
final_score = (vector_similarity * 0.6) + (recency * 0.2) + (salience * 0.2)
```

### Access Boosting
When a node is retrieved, its salience gets a small boost:
```typescript
new_salience = min(2.0, current_salience + 0.02 * log(1 + access_count))
```

## Usage

```typescript
import { SalienceScorer, DreamingWorker } from './salience';

// Calculate salience for a node
const scorer = new SalienceScorer();
const { salience, components } = scorer.calculateSalienceScore(nodeData, edgeCount);

// Run a dreaming pass
const worker = new DreamingWorker();
await worker.runPass('full', getNodes, getEdgeCount, getSimilarCount, updateNode, logPass);
```

## Database Schema

New columns added to `synthesis_nodes`:
- `salience` REAL DEFAULT 1.0 - Current salience score
- `salience_components` TEXT - JSON breakdown of score components
- `is_novel` INTEGER DEFAULT 0 - Novelty flag
- `is_emotional` INTEGER DEFAULT 0 - Emotional content flag
- `is_consequential` INTEGER DEFAULT 0 - Consequence flag
- `is_user_marked` INTEGER DEFAULT 0 - User importance flag
- `similar_count` INTEGER DEFAULT 0 - Count of similar nodes

New table `dreaming_passes`:
- `id` INTEGER PRIMARY KEY
- `pass_type` TEXT - Type of dreaming pass
- `started_at` INTEGER - Start timestamp
- `completed_at` INTEGER - Completion timestamp
- `nodes_processed` INTEGER - Total nodes examined
- `nodes_updated` INTEGER - Nodes with changed salience
- `status` TEXT - Pass status
- `error` TEXT - Error message if failed
