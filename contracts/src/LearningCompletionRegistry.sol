// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

interface ILearningProjectRegistryV2 {
    function projects(bytes32 projectId)
        external
        view
        returns (
            address learner,
            bytes32 sourceHash,
            bytes32 goalHash,
            bytes32 outlineHash,
            bytes32 workUnitManifestRoot,
            bytes32 projectDeckRoot,
            bytes32 initialPlanHash,
            uint16 chapterCount,
            uint16 workUnitCount,
            uint16 totalCardCount,
            uint8 status
        );
}

contract LearningCompletionRegistry {
    struct Completion {
        address learner;
        bytes32 projectDeckRoot;
        bytes32 progressHash;
        uint64 completedBlock;
    }

    error EmptyValue();
    error AuthorizationExpired(uint64 deadline);
    error ProjectNotReady(bytes32 projectId);
    error UnauthorizedLearner(address caller, address learner);
    error InvalidAttestor(address recovered);
    error CompletionAlreadyClaimed(bytes32 projectId);

    event LearningCompletionClaimed(
        bytes32 indexed projectId,
        address indexed learner,
        bytes32 indexed projectDeckRoot,
        bytes32 progressHash,
        uint64 completedBlock
    );

    bytes32 public constant COMPLETION_TYPEHASH = keccak256(
        "CompletionAuthorization(bytes32 projectId,address learner,bytes32 projectDeckRoot,bytes32 progressHash,uint64 deadline)"
    );
    bytes32 private constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant NAME_HASH = keccak256("Mindmark Learning Completion");
    bytes32 private constant VERSION_HASH = keccak256("1");
    uint8 private constant PROJECT_STATUS_READY = 2;

    ILearningProjectRegistryV2 public immutable sourceRegistry;
    address public immutable attestor;

    mapping(bytes32 projectId => Completion completion) public completions;

    constructor(address sourceRegistry_, address attestor_) {
        if (sourceRegistry_ == address(0) || attestor_ == address(0)) revert EmptyValue();
        sourceRegistry = ILearningProjectRegistryV2(sourceRegistry_);
        attestor = attestor_;
    }

    function claimCompletion(bytes32 projectId, bytes32 progressHash, uint64 deadline, bytes calldata signature)
        external
    {
        if (projectId == bytes32(0) || progressHash == bytes32(0)) revert EmptyValue();
        if (block.timestamp > deadline) revert AuthorizationExpired(deadline);
        if (completions[projectId].learner != address(0)) revert CompletionAlreadyClaimed(projectId);

        (address learner,,,,, bytes32 projectDeckRoot,,,,, uint8 status) = sourceRegistry.projects(projectId);
        if (status != PROJECT_STATUS_READY || projectDeckRoot == bytes32(0)) revert ProjectNotReady(projectId);
        if (msg.sender != learner) revert UnauthorizedLearner(msg.sender, learner);

        bytes32 structHash = keccak256(
            abi.encode(COMPLETION_TYPEHASH, projectId, learner, projectDeckRoot, progressHash, deadline)
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", _domainSeparator(), structHash));
        address recovered = ECDSA.recover(digest, signature);
        if (recovered != attestor) revert InvalidAttestor(recovered);

        uint64 completedBlock = uint64(block.number);
        completions[projectId] = Completion({
            learner: learner,
            projectDeckRoot: projectDeckRoot,
            progressHash: progressHash,
            completedBlock: completedBlock
        });
        emit LearningCompletionClaimed(projectId, learner, projectDeckRoot, progressHash, completedBlock);
    }

    function domainSeparator() external view returns (bytes32) {
        return _domainSeparator();
    }

    function _domainSeparator() private view returns (bytes32) {
        return keccak256(
            abi.encode(DOMAIN_TYPEHASH, NAME_HASH, VERSION_HASH, block.chainid, address(this))
        );
    }
}
