import { parseAbi } from "viem";
export const learningJourneyRegistryAbi = parseAbi([
    "function createJourney(bytes32 journeyId, bytes32 sourceHash, bytes32 goalHash, bytes32 chunkManifestRoot, uint16 chunkCount)",
    "function commitChunk(bytes32 journeyId, uint16 chunkId, bytes32 sourceChunkHash, bytes32 cardsRoot, uint16 cardCount, bytes32[] manifestProof)",
    "function finalizeDeck(bytes32 journeyId, bytes32 deckRoot, bytes32 initialPlanHash, uint16 totalCardCount)",
    "function cancelJourney(bytes32 journeyId)",
    "function coordinator() view returns (address)",
    "function isWorker(address worker) view returns (bool)",
    "function journeys(bytes32 journeyId) view returns (address learner, bytes32 sourceHash, bytes32 goalHash, bytes32 chunkManifestRoot, bytes32 deckRoot, bytes32 initialPlanHash, uint16 chunkCount, uint16 totalCardCount, uint8 status)",
    "function chunks(bytes32 journeyId, uint16 chunkId) view returns (bytes32 sourceChunkHash, bytes32 cardsRoot, address agent, uint64 committedBlock, uint16 cardCount)",
    "event JourneyCreated(bytes32 indexed journeyId, address indexed learner, bytes32 sourceHash, bytes32 goalHash, bytes32 chunkManifestRoot, uint16 chunkCount)",
    "event ChunkCommitted(bytes32 indexed journeyId, uint16 indexed chunkId, address indexed agent, bytes32 sourceChunkHash, bytes32 cardsRoot, uint16 cardCount)",
    "event DeckFinalized(bytes32 indexed journeyId, bytes32 deckRoot, bytes32 initialPlanHash, uint16 totalCardCount)",
    "event JourneyCancelled(bytes32 indexed journeyId, address indexed learner)",
]);
//# sourceMappingURL=contract.js.map