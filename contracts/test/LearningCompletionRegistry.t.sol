// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {LearningCompletionRegistry} from "../src/LearningCompletionRegistry.sol";

interface CompletionTestVm {
    function addr(uint256 privateKey) external returns (address value);
    function sign(uint256 privateKey, bytes32 digest) external returns (uint8 v, bytes32 r, bytes32 s);
    function prank(address sender) external;
    function warp(uint256 timestamp) external;
    function roll(uint256 blockNumber) external;
    function expectPartialRevert(bytes4 selector) external;
}

contract CompletionSourceRegistry {
    struct Project {
        address learner;
        bytes32 sourceHash;
        bytes32 goalHash;
        bytes32 outlineHash;
        bytes32 workUnitManifestRoot;
        bytes32 projectDeckRoot;
        bytes32 initialPlanHash;
        uint16 chapterCount;
        uint16 workUnitCount;
        uint16 totalCardCount;
        uint8 status;
    }

    mapping(bytes32 projectId => Project project) public projects;

    function setProject(bytes32 projectId, address learner, bytes32 deckRoot, uint8 status) external {
        projects[projectId] = Project({
            learner: learner,
            sourceHash: keccak256("source"),
            goalHash: keccak256("goal"),
            outlineHash: keccak256("outline"),
            workUnitManifestRoot: keccak256("manifest"),
            projectDeckRoot: deckRoot,
            initialPlanHash: keccak256("plan"),
            chapterCount: 1,
            workUnitCount: 1,
            totalCardCount: 4,
            status: status
        });
    }
}

contract LearningCompletionRegistryTest {
    CompletionTestVm private constant vm =
        CompletionTestVm(address(uint160(uint256(keccak256("hevm cheat code")))));

    uint256 private constant ATTESTOR_KEY = 0xA77E57;
    uint256 private constant OTHER_KEY = 0xB0B;
    address private constant LEARNER = address(0xA11CE);
    address private constant OTHER = address(0xB0B);
    bytes32 private constant PROJECT_ID = keccak256("project");
    bytes32 private constant DECK_ROOT = keccak256("deck");
    bytes32 private constant PROGRESS_HASH = keccak256("progress");

    CompletionSourceRegistry private source;
    LearningCompletionRegistry private completion;

    function setUp() public {
        source = new CompletionSourceRegistry();
        source.setProject(PROJECT_ID, LEARNER, DECK_ROOT, 2);
        completion = new LearningCompletionRegistry(address(source), vm.addr(ATTESTOR_KEY));
        vm.warp(1_800_000_000);
        vm.roll(777);
    }

    function testLearnerClaimsAuthorizedReadyProject() public {
        uint64 deadline = uint64(block.timestamp + 600);
        bytes memory signature = _signature(ATTESTOR_KEY, LEARNER, PROGRESS_HASH, deadline);

        vm.prank(LEARNER);
        completion.claimCompletion(PROJECT_ID, PROGRESS_HASH, deadline, signature);

        (address learner, bytes32 deckRoot, bytes32 progressHash, uint64 completedBlock) =
            completion.completions(PROJECT_ID);
        require(learner == LEARNER, "learner mismatch");
        require(deckRoot == DECK_ROOT, "deck root mismatch");
        require(progressHash == PROGRESS_HASH, "progress hash mismatch");
        require(completedBlock == 777, "block mismatch");
    }

    function testRejectsAnotherWalletAndAnotherAttestor() public {
        uint64 deadline = uint64(block.timestamp + 600);
        bytes memory validSignature = _signature(ATTESTOR_KEY, LEARNER, PROGRESS_HASH, deadline);

        vm.prank(OTHER);
        vm.expectPartialRevert(LearningCompletionRegistry.UnauthorizedLearner.selector);
        completion.claimCompletion(PROJECT_ID, PROGRESS_HASH, deadline, validSignature);

        bytes memory wrongSignature = _signature(OTHER_KEY, LEARNER, PROGRESS_HASH, deadline);
        vm.prank(LEARNER);
        vm.expectPartialRevert(LearningCompletionRegistry.InvalidAttestor.selector);
        completion.claimCompletion(PROJECT_ID, PROGRESS_HASH, deadline, wrongSignature);
    }

    function testRejectsExpiredAuthorizationAndDuplicateClaim() public {
        uint64 deadline = uint64(block.timestamp + 10);
        bytes memory signature = _signature(ATTESTOR_KEY, LEARNER, PROGRESS_HASH, deadline);
        vm.warp(block.timestamp + 11);
        vm.prank(LEARNER);
        vm.expectPartialRevert(LearningCompletionRegistry.AuthorizationExpired.selector);
        completion.claimCompletion(PROJECT_ID, PROGRESS_HASH, deadline, signature);

        deadline = uint64(block.timestamp + 600);
        signature = _signature(ATTESTOR_KEY, LEARNER, PROGRESS_HASH, deadline);
        vm.prank(LEARNER);
        completion.claimCompletion(PROJECT_ID, PROGRESS_HASH, deadline, signature);
        vm.prank(LEARNER);
        vm.expectPartialRevert(LearningCompletionRegistry.CompletionAlreadyClaimed.selector);
        completion.claimCompletion(PROJECT_ID, PROGRESS_HASH, deadline, signature);
    }

    function testRejectsProjectThatIsNotReady() public {
        source.setProject(PROJECT_ID, LEARNER, bytes32(0), 1);
        uint64 deadline = uint64(block.timestamp + 600);
        bytes memory signature = _signature(ATTESTOR_KEY, LEARNER, PROGRESS_HASH, deadline);
        vm.prank(LEARNER);
        vm.expectPartialRevert(LearningCompletionRegistry.ProjectNotReady.selector);
        completion.claimCompletion(PROJECT_ID, PROGRESS_HASH, deadline, signature);
    }

    function _signature(uint256 key, address learner, bytes32 progressHash, uint64 deadline)
        private
        returns (bytes memory)
    {
        bytes32 structHash = keccak256(
            abi.encode(completion.COMPLETION_TYPEHASH(), PROJECT_ID, learner, DECK_ROOT, progressHash, deadline)
        );
        bytes32 digest = keccak256(
            abi.encodePacked("\x19\x01", completion.domainSeparator(), structHash)
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        return abi.encodePacked(r, s, v);
    }
}
