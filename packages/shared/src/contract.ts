import { parseAbi } from "viem";

export const learningProjectRegistryV2Abi = parseAbi([
  "function createProject(bytes32 projectId, bytes32 sourceHash, bytes32 goalHash, bytes32 outlineHash, bytes32 workUnitManifestRoot, (bytes32 sourceHash, uint16 firstWorkUnitId, uint16 workUnitCount)[] seeds)",
  "function commitWorkUnit(bytes32 projectId, uint16 workUnitId, uint16 chapterId, bytes32 sourceUnitHash, bytes32 workerCardsRoot, uint16 cardCount, bytes32[] manifestProof)",
  "function finalizeChapter(bytes32 projectId, uint16 chapterId, bytes32 chapterCardsRoot, uint16 selectedCardCount)",
  "function finalizeProject(bytes32 projectId, bytes32 projectDeckRoot, bytes32 initialPlanHash, uint16 totalCardCount)",
  "function cancelProject(bytes32 projectId)",
  "function coordinator() view returns (address)",
  "function isWorker(address worker) view returns (bool)",
  "function projects(bytes32 projectId) view returns (address learner, bytes32 sourceHash, bytes32 goalHash, bytes32 outlineHash, bytes32 workUnitManifestRoot, bytes32 projectDeckRoot, bytes32 initialPlanHash, uint16 chapterCount, uint16 workUnitCount, uint16 totalCardCount, uint8 status)",
  "function chapters(bytes32 projectId, uint16 chapterId) view returns (bytes32 sourceHash, bytes32 cardsRoot, uint16 firstWorkUnitId, uint16 workUnitCount, uint16 cardCount, uint8 status)",
  "function workUnits(bytes32 projectId, uint16 workUnitId) view returns (uint16 chapterId, bytes32 sourceUnitHash, bytes32 workerCardsRoot, address worker, uint64 committedBlock, uint16 cardCount)",
  "event ProjectCreated(bytes32 indexed projectId, address indexed learner, bytes32 sourceHash, bytes32 outlineHash, uint16 chapterCount, uint16 workUnitCount)",
  "event WorkUnitCommitted(bytes32 indexed projectId, uint16 indexed chapterId, uint16 indexed workUnitId, address worker, bytes32 sourceUnitHash, bytes32 workerCardsRoot, uint16 cardCount)",
  "event ChapterFinalized(bytes32 indexed projectId, uint16 indexed chapterId, bytes32 cardsRoot, uint16 cardCount)",
  "event ProjectFinalized(bytes32 indexed projectId, bytes32 projectDeckRoot, bytes32 initialPlanHash, uint16 totalCardCount)",
  "event ProjectCancelled(bytes32 indexed projectId, address indexed learner)",
]);
