// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";

contract LearningJourneyRegistry {
    enum JourneyStatus {
        NONE,
        CREATED,
        READY,
        CANCELLED
    }

    struct Journey {
        address learner;
        bytes32 sourceHash;
        bytes32 goalHash;
        bytes32 chunkManifestRoot;
        bytes32 deckRoot;
        bytes32 initialPlanHash;
        uint16 chunkCount;
        uint16 totalCardCount;
        JourneyStatus status;
    }

    struct ChunkCommitment {
        bytes32 sourceChunkHash;
        bytes32 cardsRoot;
        address agent;
        uint64 committedBlock;
        uint16 cardCount;
    }

    error EmptyValue();
    error InvalidChunkCount(uint16 count);
    error InvalidCardCount(uint16 count);
    error DuplicateAddress();
    error JourneyAlreadyExists(bytes32 journeyId);
    error JourneyNotCreated(bytes32 journeyId);
    error InvalidJourneyState(bytes32 journeyId, JourneyStatus status);
    error UnauthorizedWorker(address caller);
    error UnauthorizedCoordinator(address caller);
    error UnauthorizedLearner(address caller);
    error ChunkOutOfRange(uint16 chunkId);
    error ChunkAlreadyCommitted(uint16 chunkId);
    error InvalidManifestProof(uint16 chunkId);
    error MissingChunk(uint16 chunkId);
    error FinalCardCountExceedsGenerated(uint16 selected, uint256 generated);

    event JourneyCreated(
        bytes32 indexed journeyId,
        address indexed learner,
        bytes32 sourceHash,
        bytes32 goalHash,
        bytes32 chunkManifestRoot,
        uint16 chunkCount
    );
    event ChunkCommitted(
        bytes32 indexed journeyId,
        uint16 indexed chunkId,
        address indexed agent,
        bytes32 sourceChunkHash,
        bytes32 cardsRoot,
        uint16 cardCount
    );
    event DeckFinalized(bytes32 indexed journeyId, bytes32 deckRoot, bytes32 initialPlanHash, uint16 totalCardCount);
    event JourneyCancelled(bytes32 indexed journeyId, address indexed learner);

    address public immutable coordinator;
    address public immutable worker0;
    address public immutable worker1;
    address public immutable worker2;

    mapping(address worker => bool allowed) public isWorker;
    mapping(bytes32 journeyId => Journey journey) public journeys;
    mapping(bytes32 journeyId => mapping(uint16 chunkId => ChunkCommitment commitment)) public chunks;

    constructor(address coordinator_, address[3] memory workers_) {
        if (
            coordinator_ == address(0) || workers_[0] == address(0) || workers_[1] == address(0)
                || workers_[2] == address(0)
        ) revert EmptyValue();
        if (
            coordinator_ == workers_[0] || coordinator_ == workers_[1] || coordinator_ == workers_[2]
                || workers_[0] == workers_[1] || workers_[0] == workers_[2] || workers_[1] == workers_[2]
        ) revert DuplicateAddress();

        coordinator = coordinator_;
        worker0 = workers_[0];
        worker1 = workers_[1];
        worker2 = workers_[2];
        isWorker[workers_[0]] = true;
        isWorker[workers_[1]] = true;
        isWorker[workers_[2]] = true;
    }

    function createJourney(
        bytes32 journeyId,
        bytes32 sourceHash,
        bytes32 goalHash,
        bytes32 chunkManifestRoot,
        uint16 chunkCount
    ) external {
        if (
            journeyId == bytes32(0) || sourceHash == bytes32(0) || goalHash == bytes32(0)
                || chunkManifestRoot == bytes32(0)
        ) revert EmptyValue();
        if (chunkCount < 2 || chunkCount > 4) revert InvalidChunkCount(chunkCount);
        if (journeys[journeyId].status != JourneyStatus.NONE) revert JourneyAlreadyExists(journeyId);

        journeys[journeyId] = Journey({
            learner: msg.sender,
            sourceHash: sourceHash,
            goalHash: goalHash,
            chunkManifestRoot: chunkManifestRoot,
            deckRoot: bytes32(0),
            initialPlanHash: bytes32(0),
            chunkCount: chunkCount,
            totalCardCount: 0,
            status: JourneyStatus.CREATED
        });

        emit JourneyCreated(journeyId, msg.sender, sourceHash, goalHash, chunkManifestRoot, chunkCount);
    }

    function commitChunk(
        bytes32 journeyId,
        uint16 chunkId,
        bytes32 sourceChunkHash,
        bytes32 cardsRoot,
        uint16 cardCount,
        bytes32[] calldata manifestProof
    ) external {
        if (!isWorker[msg.sender]) revert UnauthorizedWorker(msg.sender);
        Journey storage journey = journeys[journeyId];
        if (journey.status == JourneyStatus.NONE) revert JourneyNotCreated(journeyId);
        if (journey.status != JourneyStatus.CREATED) {
            revert InvalidJourneyState(journeyId, journey.status);
        }
        if (chunkId >= journey.chunkCount) revert ChunkOutOfRange(chunkId);
        if (sourceChunkHash == bytes32(0) || cardsRoot == bytes32(0)) revert EmptyValue();
        if (cardCount == 0 || cardCount > 30) revert InvalidCardCount(cardCount);
        if (chunks[journeyId][chunkId].agent != address(0)) revert ChunkAlreadyCommitted(chunkId);

        bytes32 leaf = keccak256(abi.encode(journeyId, chunkId, sourceChunkHash));
        if (!MerkleProof.verifyCalldata(manifestProof, journey.chunkManifestRoot, leaf)) {
            revert InvalidManifestProof(chunkId);
        }

        // This is deliberately the only per-commit state write: independent chunks
        // occupy independent mapping keys and do not contend on a shared counter.
        chunks[journeyId][chunkId] = ChunkCommitment({
            sourceChunkHash: sourceChunkHash,
            cardsRoot: cardsRoot,
            agent: msg.sender,
            committedBlock: uint64(block.number),
            cardCount: cardCount
        });

        emit ChunkCommitted(journeyId, chunkId, msg.sender, sourceChunkHash, cardsRoot, cardCount);
    }

    function finalizeDeck(bytes32 journeyId, bytes32 deckRoot, bytes32 initialPlanHash, uint16 totalCardCount)
        external
    {
        if (msg.sender != coordinator) revert UnauthorizedCoordinator(msg.sender);
        Journey storage journey = journeys[journeyId];
        if (journey.status == JourneyStatus.NONE) revert JourneyNotCreated(journeyId);
        if (journey.status != JourneyStatus.CREATED) {
            revert InvalidJourneyState(journeyId, journey.status);
        }
        if (deckRoot == bytes32(0) || initialPlanHash == bytes32(0)) revert EmptyValue();
        if (totalCardCount < 4 || totalCardCount > 30) revert InvalidCardCount(totalCardCount);

        uint256 generatedCardCount;
        for (uint16 chunkId = 0; chunkId < journey.chunkCount; ++chunkId) {
            ChunkCommitment storage commitment = chunks[journeyId][chunkId];
            if (commitment.agent == address(0)) revert MissingChunk(chunkId);
            generatedCardCount += commitment.cardCount;
        }
        if (totalCardCount > generatedCardCount) {
            revert FinalCardCountExceedsGenerated(totalCardCount, generatedCardCount);
        }

        journey.deckRoot = deckRoot;
        journey.initialPlanHash = initialPlanHash;
        journey.totalCardCount = totalCardCount;
        journey.status = JourneyStatus.READY;

        emit DeckFinalized(journeyId, deckRoot, initialPlanHash, totalCardCount);
    }

    function cancelJourney(bytes32 journeyId) external {
        Journey storage journey = journeys[journeyId];
        if (journey.status == JourneyStatus.NONE) revert JourneyNotCreated(journeyId);
        if (msg.sender != journey.learner) revert UnauthorizedLearner(msg.sender);
        if (journey.status != JourneyStatus.CREATED) {
            revert InvalidJourneyState(journeyId, journey.status);
        }

        journey.status = JourneyStatus.CANCELLED;
        emit JourneyCancelled(journeyId, msg.sender);
    }
}

