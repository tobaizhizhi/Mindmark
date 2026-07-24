// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {LearningJourneyRegistry} from "../src/LearningJourneyRegistry.sol";

interface RegistryVm {
    function prank(address sender) external;
    function expectRevert(bytes4 selector) external;
    function expectRevert(bytes calldata revertData) external;
    function expectPartialRevert(bytes4 selector) external;
}

contract LearningJourneyRegistryTest {
    RegistryVm private constant vm = RegistryVm(address(uint160(uint256(keccak256("hevm cheat code")))));

    address private constant LEARNER = address(0xA11CE);
    address private constant OTHER = address(0xB0B);
    address private constant COORDINATOR = address(0xC001);
    address private constant WORKER_0 = address(0x1000);
    address private constant WORKER_1 = address(0x1001);
    address private constant WORKER_2 = address(0x1002);

    bytes32 private constant JOURNEY_ID = keccak256("journey-a");
    bytes32 private constant SOURCE_HASH = keccak256("source");
    bytes32 private constant GOAL_HASH = keccak256("goal");
    bytes32 private constant DECK_ROOT = keccak256("deck");
    bytes32 private constant PLAN_HASH = keccak256("plan");

    LearningJourneyRegistry private registry;
    bytes32[3] private sourceChunkHashes;
    bytes32[3] private cardsRoots;
    bytes32[3] private leaves;
    bytes32 private manifestRoot;

    function setUp() public {
        address[3] memory workers = [WORKER_0, WORKER_1, WORKER_2];
        registry = new LearningJourneyRegistry(COORDINATOR, workers);

        for (uint16 i = 0; i < 3; ++i) {
            sourceChunkHashes[i] = keccak256(abi.encode("source chunk", i));
            cardsRoots[i] = keccak256(abi.encode("cards", i));
            leaves[i] = keccak256(abi.encode(JOURNEY_ID, i, sourceChunkHashes[i]));
        }
        manifestRoot = _hashPair(_hashPair(leaves[0], leaves[1]), leaves[2]);
    }

    function testConstructorFixesCoordinatorAndThreeDistinctWorkers() public view {
        require(registry.coordinator() == COORDINATOR, "coordinator mismatch");
        require(registry.worker0() == WORKER_0, "worker 0 mismatch");
        require(registry.worker1() == WORKER_1, "worker 1 mismatch");
        require(registry.worker2() == WORKER_2, "worker 2 mismatch");
        require(registry.isWorker(WORKER_0), "worker 0 missing");
        require(!registry.isWorker(OTHER), "unexpected worker");
    }

    function testConstructorRejectsZeroAndDuplicateAddresses() public {
        address[3] memory validWorkers = [WORKER_0, WORKER_1, WORKER_2];
        vm.expectPartialRevert(LearningJourneyRegistry.EmptyValue.selector);
        new LearningJourneyRegistry(address(0), validWorkers);

        address[3] memory duplicateWorkers = [WORKER_0, WORKER_0, WORKER_2];
        vm.expectPartialRevert(LearningJourneyRegistry.DuplicateAddress.selector);
        new LearningJourneyRegistry(COORDINATOR, duplicateWorkers);
    }

    function testCreateJourneyStoresLearnerAndCommitments() public {
        _create(JOURNEY_ID, manifestRoot);
        (
            address learner,
            bytes32 sourceHash,
            bytes32 goalHash,
            bytes32 storedManifestRoot,,,
            uint16 chunkCount,
            uint16 totalCardCount,
            LearningJourneyRegistry.JourneyStatus status
        ) = registry.journeys(JOURNEY_ID);

        require(learner == LEARNER, "learner mismatch");
        require(sourceHash == SOURCE_HASH, "source mismatch");
        require(goalHash == GOAL_HASH, "goal mismatch");
        require(storedManifestRoot == manifestRoot, "manifest mismatch");
        require(chunkCount == 3, "chunk count mismatch");
        require(totalCardCount == 0, "unexpected card count");
        require(status == LearningJourneyRegistry.JourneyStatus.CREATED, "status mismatch");
    }

    function testCreateRejectsDuplicateEmptyAndInvalidChunkCount() public {
        _create(JOURNEY_ID, manifestRoot);

        vm.prank(LEARNER);
        vm.expectPartialRevert(LearningJourneyRegistry.JourneyAlreadyExists.selector);
        registry.createJourney(JOURNEY_ID, SOURCE_HASH, GOAL_HASH, manifestRoot, 3);

        vm.prank(LEARNER);
        vm.expectPartialRevert(LearningJourneyRegistry.EmptyValue.selector);
        registry.createJourney(bytes32(0), SOURCE_HASH, GOAL_HASH, manifestRoot, 3);

        vm.prank(LEARNER);
        vm.expectPartialRevert(LearningJourneyRegistry.InvalidChunkCount.selector);
        registry.createJourney(keccak256("bad-count"), SOURCE_HASH, GOAL_HASH, manifestRoot, 13);
    }

    function testCreateAllowsTwelveChunks() public {
        bytes32 largeJourneyId = keccak256("large-journey");
        _createWithCount(largeJourneyId, keccak256("large-manifest"), 12);
        (,,,,,, uint16 chunkCount,, LearningJourneyRegistry.JourneyStatus status) =
            registry.journeys(largeJourneyId);
        require(chunkCount == 12, "large chunk count mismatch");
        require(status == LearningJourneyRegistry.JourneyStatus.CREATED, "large journey not created");
    }

    function testOnlyWorkerCanCommit() public {
        _create(JOURNEY_ID, manifestRoot);
        vm.prank(OTHER);
        vm.expectPartialRevert(LearningJourneyRegistry.UnauthorizedWorker.selector);
        registry.commitChunk(JOURNEY_ID, 0, sourceChunkHashes[0], cardsRoots[0], 2, _proofFor(0));
    }

    function testCommitRejectsWrongProofOutOfRangeAndEmptyRoot() public {
        _create(JOURNEY_ID, manifestRoot);

        vm.prank(WORKER_0);
        vm.expectPartialRevert(LearningJourneyRegistry.InvalidManifestProof.selector);
        registry.commitChunk(JOURNEY_ID, 0, sourceChunkHashes[1], cardsRoots[0], 2, _proofFor(0));

        vm.prank(WORKER_0);
        vm.expectPartialRevert(LearningJourneyRegistry.ChunkOutOfRange.selector);
        registry.commitChunk(JOURNEY_ID, 3, sourceChunkHashes[0], cardsRoots[0], 2, new bytes32[](0));

        vm.prank(WORKER_0);
        vm.expectPartialRevert(LearningJourneyRegistry.EmptyValue.selector);
        registry.commitChunk(JOURNEY_ID, 0, sourceChunkHashes[0], bytes32(0), 2, _proofFor(0));
    }

    function testThreeWorkersCommitIndependentChunkKeys() public {
        _create(JOURNEY_ID, manifestRoot);
        _commit(JOURNEY_ID, 0, WORKER_0);
        _commit(JOURNEY_ID, 1, WORKER_1);
        _commit(JOURNEY_ID, 2, WORKER_2);

        _assertChunk(JOURNEY_ID, 0, WORKER_0);
        _assertChunk(JOURNEY_ID, 1, WORKER_1);
        _assertChunk(JOURNEY_ID, 2, WORKER_2);
    }

    function testDuplicateChunkCommitFails() public {
        _create(JOURNEY_ID, manifestRoot);
        _commit(JOURNEY_ID, 0, WORKER_0);

        vm.prank(WORKER_1);
        vm.expectPartialRevert(LearningJourneyRegistry.ChunkAlreadyCommitted.selector);
        registry.commitChunk(JOURNEY_ID, 0, sourceChunkHashes[0], cardsRoots[0], 2, _proofFor(0));
    }

    function testFinalizeRequiresEveryChunkAndCoordinator() public {
        _create(JOURNEY_ID, manifestRoot);
        _commit(JOURNEY_ID, 0, WORKER_0);

        vm.prank(COORDINATOR);
        vm.expectRevert(abi.encodeWithSelector(LearningJourneyRegistry.MissingChunk.selector, 1));
        registry.finalizeDeck(JOURNEY_ID, DECK_ROOT, PLAN_HASH, 4);

        _commit(JOURNEY_ID, 1, WORKER_1);
        _commit(JOURNEY_ID, 2, WORKER_2);
        vm.prank(OTHER);
        vm.expectPartialRevert(LearningJourneyRegistry.UnauthorizedCoordinator.selector);
        registry.finalizeDeck(JOURNEY_ID, DECK_ROOT, PLAN_HASH, 4);
    }

    function testFinalizeRejectsMoreCardsThanWorkersGenerated() public {
        _createAndCommitAll(JOURNEY_ID);
        vm.prank(COORDINATOR);
        vm.expectPartialRevert(LearningJourneyRegistry.FinalCardCountExceedsGenerated.selector);
        registry.finalizeDeck(JOURNEY_ID, DECK_ROOT, PLAN_HASH, 7);
    }

    function testFinalizeStoresReadyDeckAndCannotRepeat() public {
        _createAndCommitAll(JOURNEY_ID);
        vm.prank(COORDINATOR);
        registry.finalizeDeck(JOURNEY_ID, DECK_ROOT, PLAN_HASH, 6);

        (,,,, bytes32 deckRoot, bytes32 planHash,, uint16 cardCount, LearningJourneyRegistry.JourneyStatus status) =
            registry.journeys(JOURNEY_ID);
        require(deckRoot == DECK_ROOT, "deck root mismatch");
        require(planHash == PLAN_HASH, "plan hash mismatch");
        require(cardCount == 6, "card count mismatch");
        require(status == LearningJourneyRegistry.JourneyStatus.READY, "not ready");

        vm.prank(COORDINATOR);
        vm.expectPartialRevert(LearningJourneyRegistry.InvalidJourneyState.selector);
        registry.finalizeDeck(JOURNEY_ID, DECK_ROOT, PLAN_HASH, 6);
    }

    function testOnlyLearnerCanCancelAndCancellationStopsCommits() public {
        _create(JOURNEY_ID, manifestRoot);
        vm.prank(OTHER);
        vm.expectPartialRevert(LearningJourneyRegistry.UnauthorizedLearner.selector);
        registry.cancelJourney(JOURNEY_ID);

        vm.prank(LEARNER);
        registry.cancelJourney(JOURNEY_ID);

        vm.prank(WORKER_0);
        vm.expectPartialRevert(LearningJourneyRegistry.InvalidJourneyState.selector);
        registry.commitChunk(JOURNEY_ID, 0, sourceChunkHashes[0], cardsRoots[0], 2, _proofFor(0));
    }

    function testSameChunkIdInDifferentJourneysUsesIndependentState() public {
        bytes32 secondJourneyId = keccak256("journey-b");
        bytes32 secondSource = keccak256("journey-b-source-0");
        bytes32 secondLeaf = keccak256(abi.encode(secondJourneyId, uint16(0), secondSource));
        bytes32 secondSource1 = keccak256("journey-b-source-1");
        bytes32 secondLeaf1 = keccak256(abi.encode(secondJourneyId, uint16(1), secondSource1));
        bytes32 secondRoot = _hashPair(secondLeaf, secondLeaf1);

        _create(JOURNEY_ID, manifestRoot);
        _createWithCount(secondJourneyId, secondRoot, 2);
        _commit(JOURNEY_ID, 0, WORKER_0);

        bytes32[] memory proof = new bytes32[](1);
        proof[0] = secondLeaf1;
        vm.prank(WORKER_1);
        registry.commitChunk(secondJourneyId, 0, secondSource, keccak256("other cards"), 4, proof);

        (bytes32 firstSource,, address firstAgent,,) = registry.chunks(JOURNEY_ID, 0);
        (bytes32 otherSource,, address otherAgent,,) = registry.chunks(secondJourneyId, 0);
        require(firstSource == sourceChunkHashes[0] && firstAgent == WORKER_0, "journey a changed");
        require(otherSource == secondSource && otherAgent == WORKER_1, "journey b mismatch");
    }

    function _createAndCommitAll(bytes32 journeyId) private {
        _create(journeyId, manifestRoot);
        _commit(journeyId, 0, WORKER_0);
        _commit(journeyId, 1, WORKER_1);
        _commit(journeyId, 2, WORKER_2);
    }

    function _create(bytes32 journeyId, bytes32 root) private {
        _createWithCount(journeyId, root, 3);
    }

    function _createWithCount(bytes32 journeyId, bytes32 root, uint16 count) private {
        vm.prank(LEARNER);
        registry.createJourney(journeyId, SOURCE_HASH, GOAL_HASH, root, count);
    }

    function _commit(bytes32 journeyId, uint16 chunkId, address worker) private {
        vm.prank(worker);
        registry.commitChunk(journeyId, chunkId, sourceChunkHashes[chunkId], cardsRoots[chunkId], 2, _proofFor(chunkId));
    }

    function _assertChunk(bytes32 journeyId, uint16 chunkId, address expectedAgent) private view {
        (bytes32 sourceHash, bytes32 cardsRoot, address agent, uint64 committedBlock, uint16 cardCount) =
            registry.chunks(journeyId, chunkId);
        require(sourceHash == sourceChunkHashes[chunkId], "source chunk mismatch");
        require(cardsRoot == cardsRoots[chunkId], "cards root mismatch");
        require(agent == expectedAgent, "agent mismatch");
        require(committedBlock != 0, "block missing");
        require(cardCount == 2, "card count mismatch");
    }

    function _proofFor(uint16 chunkId) private view returns (bytes32[] memory proof) {
        if (chunkId < 2) {
            proof = new bytes32[](2);
            proof[0] = leaves[chunkId == 0 ? 1 : 0];
            proof[1] = leaves[2];
        } else {
            proof = new bytes32[](1);
            proof[0] = _hashPair(leaves[0], leaves[1]);
        }
    }

    function _hashPair(bytes32 left, bytes32 right) private pure returns (bytes32) {
        return left < right ? keccak256(abi.encodePacked(left, right)) : keccak256(abi.encodePacked(right, left));
    }
}
