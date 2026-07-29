// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {LearningProjectRegistryV2} from "../src/LearningProjectRegistryV2.sol";

interface RegistryV2Vm {
    function prank(address sender) external;
    function expectPartialRevert(bytes4 selector) external;
}

contract LearningProjectRegistryV2Test {
    RegistryV2Vm private constant vm = RegistryV2Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    address private constant LEARNER = address(0xA11CE);
    address private constant OTHER = address(0xB0B);
    address private constant COORDINATOR = address(0xC001);
    address private constant WORKER_0 = address(0x1000);
    address private constant WORKER_1 = address(0x1001);
    address private constant WORKER_2 = address(0x1002);

    bytes32 private constant PROJECT_ID = keccak256("project-a");
    bytes32 private constant SOURCE_HASH = keccak256("source");
    bytes32 private constant GOAL_HASH = keccak256("goal");
    bytes32 private constant OUTLINE_HASH = keccak256("outline");
    bytes32 private constant PLAN_HASH = keccak256("plan");
    bytes32 private constant DECK_ROOT = keccak256("deck");

    LearningProjectRegistryV2 private registry;
    bytes32[2] private sourceUnitHashes;
    bytes32[2] private workerRoots;
    bytes32[2] private manifestLeaves;
    bytes32 private manifestRoot;

    function setUp() public {
        address[3] memory workers = [WORKER_0, WORKER_1, WORKER_2];
        registry = new LearningProjectRegistryV2(COORDINATOR, workers);
        for (uint16 index = 0; index < 2; ++index) {
            sourceUnitHashes[index] = keccak256(abi.encode("work unit", index));
            workerRoots[index] = keccak256(abi.encode("worker cards", index));
            manifestLeaves[index] = keccak256(
                abi.encode("MINDMARK_WORK_UNIT_V2", PROJECT_ID, index, index, sourceUnitHashes[index])
            );
        }
        manifestRoot = _hashPair(manifestLeaves[0], manifestLeaves[1]);
    }

    function testCreateStoresProjectAndChapterSeeds() public {
        _create();
        (
            address learner,
            bytes32 sourceHash,
            bytes32 goalHash,
            bytes32 outlineHash,
            bytes32 storedManifestRoot,,,
            uint16 chapterCount,
            uint16 workUnitCount,
            uint16 totalCardCount,
            LearningProjectRegistryV2.ProjectStatus status
        ) = registry.projects(PROJECT_ID);
        require(learner == LEARNER, "learner mismatch");
        require(sourceHash == SOURCE_HASH, "source mismatch");
        require(goalHash == GOAL_HASH, "goal mismatch");
        require(outlineHash == OUTLINE_HASH, "outline mismatch");
        require(storedManifestRoot == manifestRoot, "manifest mismatch");
        require(chapterCount == 2 && workUnitCount == 2, "count mismatch");
        require(totalCardCount == 0, "unexpected cards");
        require(status == LearningProjectRegistryV2.ProjectStatus.CREATED, "status mismatch");

        (
            bytes32 chapterSource,,
            uint16 firstWorkUnitId,
            uint16 workUnitCountForChapter,,
            LearningProjectRegistryV2.ChapterStatus chapterStatus
        ) = registry.chapters(PROJECT_ID, 1);
        require(chapterSource == keccak256("chapter-1"), "chapter source mismatch");
        require(firstWorkUnitId == 1 && workUnitCountForChapter == 1, "chapter seed mismatch");
        require(chapterStatus == LearningProjectRegistryV2.ChapterStatus.OPEN, "chapter not open");
    }

    function testWorkersCommitAndCoordinatorFinalizesEachChapterAndProject() public {
        _create();
        _commit(0, WORKER_0);
        _commit(1, WORKER_1);

        vm.prank(COORDINATOR);
        registry.finalizeChapter(PROJECT_ID, 0, keccak256("chapter cards 0"), 4);
        vm.prank(COORDINATOR);
        registry.finalizeChapter(PROJECT_ID, 1, keccak256("chapter cards 1"), 3);

        vm.prank(COORDINATOR);
        registry.finalizeProject(PROJECT_ID, DECK_ROOT, PLAN_HASH, 7);

        (,,,,,,,,, uint16 totalCardCount, LearningProjectRegistryV2.ProjectStatus status) = registry.projects(PROJECT_ID);
        require(totalCardCount == 7, "total cards mismatch");
        require(status == LearningProjectRegistryV2.ProjectStatus.READY, "project not ready");
    }

    function testCommitRejectsWrongProofAndOnlyCoordinatorCanFinalize() public {
        _create();
        bytes32[] memory wrongProof = new bytes32[](1);
        wrongProof[0] = bytes32(0);
        vm.prank(WORKER_0);
        vm.expectPartialRevert(LearningProjectRegistryV2.InvalidManifestProof.selector);
        registry.commitWorkUnit(PROJECT_ID, 0, 0, sourceUnitHashes[0], workerRoots[0], 4, wrongProof);

        _commit(0, WORKER_0);
        vm.prank(OTHER);
        vm.expectPartialRevert(LearningProjectRegistryV2.UnauthorizedCoordinator.selector);
        registry.finalizeChapter(PROJECT_ID, 0, keccak256("cards"), 4);
    }

    function testMissingWorkUnitOrChapterBlocksFinalization() public {
        _create();
        vm.prank(COORDINATOR);
        vm.expectPartialRevert(LearningProjectRegistryV2.MissingWorkUnit.selector);
        registry.finalizeChapter(PROJECT_ID, 0, keccak256("cards"), 4);

        _commit(0, WORKER_0);
        vm.prank(COORDINATOR);
        registry.finalizeChapter(PROJECT_ID, 0, keccak256("cards"), 4);

        vm.prank(COORDINATOR);
        vm.expectPartialRevert(LearningProjectRegistryV2.MissingChapter.selector);
        registry.finalizeProject(PROJECT_ID, DECK_ROOT, PLAN_HASH, 4);
    }

    function testOnlyLearnerCanCancelBeforeReady() public {
        _create();
        vm.prank(OTHER);
        vm.expectPartialRevert(LearningProjectRegistryV2.UnauthorizedLearner.selector);
        registry.cancelProject(PROJECT_ID);

        vm.prank(LEARNER);
        registry.cancelProject(PROJECT_ID);
        vm.prank(WORKER_0);
        vm.expectPartialRevert(LearningProjectRegistryV2.InvalidProjectState.selector);
        registry.commitWorkUnit(PROJECT_ID, 0, 0, sourceUnitHashes[0], workerRoots[0], 4, _proofFor(0));
    }

    function _create() private {
        LearningProjectRegistryV2.ChapterSeed[] memory seeds = new LearningProjectRegistryV2.ChapterSeed[](2);
        seeds[0] = LearningProjectRegistryV2.ChapterSeed({
            sourceHash: keccak256("chapter-0"), firstWorkUnitId: 0, workUnitCount: 1
        });
        seeds[1] = LearningProjectRegistryV2.ChapterSeed({
            sourceHash: keccak256("chapter-1"), firstWorkUnitId: 1, workUnitCount: 1
        });
        vm.prank(LEARNER);
        registry.createProject(PROJECT_ID, SOURCE_HASH, GOAL_HASH, OUTLINE_HASH, manifestRoot, seeds);
    }

    function _commit(uint16 workUnitId, address worker) private {
        vm.prank(worker);
        registry.commitWorkUnit(
            PROJECT_ID,
            workUnitId,
            workUnitId,
            sourceUnitHashes[workUnitId],
            workerRoots[workUnitId],
            4,
            _proofFor(workUnitId)
        );
    }

    function _proofFor(uint16 workUnitId) private view returns (bytes32[] memory proof) {
        proof = new bytes32[](1);
        proof[0] = manifestLeaves[workUnitId == 0 ? 1 : 0];
    }

    function _hashPair(bytes32 left, bytes32 right) private pure returns (bytes32) {
        return left < right ? keccak256(abi.encodePacked(left, right)) : keccak256(abi.encodePacked(right, left));
    }
}
