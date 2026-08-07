// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

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

    function workUnits(bytes32 projectId, uint16 workUnitId)
        external
        view
        returns (
            uint16 chapterId,
            bytes32 sourceUnitHash,
            bytes32 workerCardsRoot,
            address worker,
            uint64 committedBlock,
            uint16 cardCount
        );
}

contract LearningProjectEscrow is ReentrancyGuard {
    uint8 private constant PROJECT_CREATED = 1;
    uint8 private constant PROJECT_READY = 2;
    uint8 private constant PROJECT_CANCELLED = 3;

    struct ProjectEscrow {
        address sponsor;
        bytes32 pricingRoot;
        uint128 totalBudget;
        uint128 remainingBudget;
        uint16 workUnitCount;
        uint16 settledWorkUnitCount;
        uint64 fundedBlock;
        bool refunded;
    }

    error EmptyValue();
    error ProjectNotFundable(bytes32 projectId, uint8 status);
    error ProjectAlreadyFunded(bytes32 projectId);
    error InvalidRewardCount(uint256 expected, uint256 received);
    error InvalidRewardAmount(uint16 workUnitId);
    error InvalidFundingAmount(uint256 expected, uint256 received);
    error ProjectNotFunded(bytes32 projectId);
    error UnauthorizedSponsor(address caller);
    error WorkUnitOutOfRange(uint16 workUnitId);
    error MissingWorkUnitCommitment(uint16 workUnitId);
    error RewardAlreadyReleased(uint16 workUnitId);
    error ProjectNotActive(bytes32 projectId, uint8 status);
    error ProjectNotCancelled(bytes32 projectId, uint8 status);
    error ProjectAlreadyRefunded(bytes32 projectId);
    error NativeTransferFailed(address recipient, uint256 amount);

    event ProjectFunded(
        bytes32 indexed projectId,
        address indexed sponsor,
        bytes32 pricingRoot,
        uint16 workUnitCount,
        uint256 totalBudget
    );
    event RewardReleased(bytes32 indexed projectId, uint16 indexed workUnitId, address indexed worker, uint256 amount);
    event ProjectRefunded(bytes32 indexed projectId, address indexed sponsor, uint256 amount);

    ILearningProjectRegistryV2 public immutable registry;

    mapping(bytes32 projectId => ProjectEscrow escrow) public projectEscrows;
    mapping(bytes32 projectId => mapping(uint16 workUnitId => uint128 amount)) public workUnitRewardAmounts;
    mapping(bytes32 projectId => mapping(uint16 workUnitId => bool released)) public rewardReleased;

    constructor(address registry_) {
        if (registry_ == address(0)) revert EmptyValue();
        registry = ILearningProjectRegistryV2(registry_);
    }

    function fundProject(bytes32 projectId, uint128[] calldata rewardAmounts) external payable {
        if (projectId == bytes32(0)) revert EmptyValue();
        ProjectEscrow storage projectEscrow = projectEscrows[projectId];
        if (projectEscrow.sponsor != address(0)) revert ProjectAlreadyFunded(projectId);

        (address learner,,,,,,, uint16 chapterCount, uint16 workUnitCount,, uint8 status) = registry.projects(projectId);
        if (learner == address(0) || chapterCount == 0 || workUnitCount == 0 || status != PROJECT_CREATED) {
            revert ProjectNotFundable(projectId, status);
        }
        if (rewardAmounts.length != workUnitCount) {
            revert InvalidRewardCount(workUnitCount, rewardAmounts.length);
        }
        uint256 totalBudget;
        for (uint16 workUnitId = 0; workUnitId < workUnitCount; ++workUnitId) {
            uint128 amount = rewardAmounts[workUnitId];
            if (amount == 0) revert InvalidRewardAmount(workUnitId);
            totalBudget += amount;
            workUnitRewardAmounts[projectId][workUnitId] = amount;
        }
        if (totalBudget > type(uint128).max || msg.value != totalBudget) {
            revert InvalidFundingAmount(totalBudget, msg.value);
        }
        bytes32 pricingRoot = keccak256(
            abi.encode("MINDMARK_WORK_UNIT_PRICING_V1", projectId, rewardAmounts)
        );

        projectEscrows[projectId] = ProjectEscrow({
            sponsor: msg.sender,
            pricingRoot: pricingRoot,
            totalBudget: uint128(totalBudget),
            remainingBudget: uint128(totalBudget),
            workUnitCount: workUnitCount,
            settledWorkUnitCount: 0,
            fundedBlock: uint64(block.number),
            refunded: false
        });
        emit ProjectFunded(projectId, msg.sender, pricingRoot, workUnitCount, totalBudget);
    }

    function releaseReward(bytes32 projectId, uint16 workUnitId) external nonReentrant {
        ProjectEscrow storage projectEscrow = projectEscrows[projectId];
        if (projectEscrow.sponsor == address(0)) revert ProjectNotFunded(projectId);
        if (msg.sender != projectEscrow.sponsor) revert UnauthorizedSponsor(msg.sender);
        if (workUnitId >= projectEscrow.workUnitCount) revert WorkUnitOutOfRange(workUnitId);
        if (rewardReleased[projectId][workUnitId]) revert RewardAlreadyReleased(workUnitId);

        (,,,,,,,,,, uint8 status) = registry.projects(projectId);
        if (status != PROJECT_CREATED && status != PROJECT_READY) revert ProjectNotActive(projectId, status);
        (,,, address worker, uint64 committedBlock, uint16 cardCount) = registry.workUnits(projectId, workUnitId);
        if (worker == address(0) || committedBlock == 0 || cardCount == 0) {
            revert MissingWorkUnitCommitment(workUnitId);
        }

        uint256 amount = workUnitRewardAmounts[projectId][workUnitId];
        rewardReleased[projectId][workUnitId] = true;
        projectEscrow.remainingBudget -= uint128(amount);
        projectEscrow.settledWorkUnitCount += 1;
        (bool sent,) = payable(worker).call{value: amount}("");
        if (!sent) revert NativeTransferFailed(worker, amount);
        emit RewardReleased(projectId, workUnitId, worker, amount);
    }

    function refundCancelledProject(bytes32 projectId) external nonReentrant {
        ProjectEscrow storage projectEscrow = projectEscrows[projectId];
        if (projectEscrow.sponsor == address(0)) revert ProjectNotFunded(projectId);
        if (msg.sender != projectEscrow.sponsor) revert UnauthorizedSponsor(msg.sender);
        if (projectEscrow.refunded) revert ProjectAlreadyRefunded(projectId);
        (,,,,,,,,,, uint8 status) = registry.projects(projectId);
        if (status != PROJECT_CANCELLED) revert ProjectNotCancelled(projectId, status);

        uint256 amount = projectEscrow.remainingBudget;
        projectEscrow.refunded = true;
        projectEscrow.remainingBudget = 0;
        (bool sent,) = payable(projectEscrow.sponsor).call{value: amount}("");
        if (!sent) revert NativeTransferFailed(projectEscrow.sponsor, amount);
        emit ProjectRefunded(projectId, projectEscrow.sponsor, amount);
    }
}
