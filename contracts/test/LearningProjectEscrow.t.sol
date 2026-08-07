// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {LearningProjectEscrow} from "../src/LearningProjectEscrow.sol";
import {LearningProjectRegistryV2} from "../src/LearningProjectRegistryV2.sol";

interface EscrowVm {
    function deal(address account, uint256 balance) external;
    function prank(address sender) external;
    function expectPartialRevert(bytes4 selector) external;
}

contract LearningProjectEscrowTest {
    EscrowVm private constant vm = EscrowVm(address(uint160(uint256(keccak256("hevm cheat code")))));

    address private constant LEARNER = address(0xA11CE);
    address private constant SPONSOR = address(0x5005);
    address private constant COORDINATOR = address(0xC001);
    address private constant WORKER_0 = address(0x1000);
    address private constant WORKER_1 = address(0x1001);
    address private constant WORKER_2 = address(0x1002);

    bytes32 private constant PROJECT_ID = keccak256("escrow-project");
    uint128 private constant REWARD_0 = 0.0008 ether;
    uint128 private constant REWARD_1 = 0.0018 ether;
    uint256 private constant TOTAL_REWARD = REWARD_0 + REWARD_1;

    LearningProjectRegistryV2 private registry;
    LearningProjectEscrow private escrow;
    bytes32[2] private sourceUnitHashes;
    bytes32[2] private manifestLeaves;
    bytes32 private manifestRoot;

    function setUp() public {
        address[3] memory workers = [WORKER_0, WORKER_1, WORKER_2];
        registry = new LearningProjectRegistryV2(COORDINATOR, workers);
        escrow = new LearningProjectEscrow(address(registry));
        for (uint16 index = 0; index < 2; ++index) {
            sourceUnitHashes[index] = keccak256(abi.encode("escrow work unit", index));
            manifestLeaves[index] =
                keccak256(abi.encode("MINDMARK_WORK_UNIT_V2", PROJECT_ID, index, index, sourceUnitHashes[index]));
        }
        manifestRoot = _hashPair(manifestLeaves[0], manifestLeaves[1]);
        _createProject();
        vm.deal(SPONSOR, 10 ether);
    }

    function testSponsorFundsExactProjectBudget() public {
        _fund();

        (
            address sponsor,
            bytes32 pricingRoot,
            uint128 totalBudget,
            uint128 remainingBudget,
            uint16 workUnitCount,
            uint16 settledWorkUnitCount,
            uint64 fundedBlock,
            bool refunded
        ) = escrow.projectEscrows(PROJECT_ID);
        require(sponsor == SPONSOR, "sponsor mismatch");
        require(pricingRoot != bytes32(0), "pricing root missing");
        require(totalBudget == TOTAL_REWARD && remainingBudget == TOTAL_REWARD, "budget mismatch");
        require(escrow.workUnitRewardAmounts(PROJECT_ID, 0) == REWARD_0, "reward 0 mismatch");
        require(escrow.workUnitRewardAmounts(PROJECT_ID, 1) == REWARD_1, "reward 1 mismatch");
        require(workUnitCount == 2 && settledWorkUnitCount == 0, "count mismatch");
        require(fundedBlock > 0, "funded block missing");
        require(!refunded, "unexpected refund");
    }

    function testPricingRootMatchesTypeScriptVector() public pure {
        uint128[] memory rewards = new uint128[](2);
        rewards[0] = 0.0008 ether;
        rewards[1] = 0.0018 ether;
        bytes32 vectorProjectId = 0x1212121212121212121212121212121212121212121212121212121212121212;
        bytes32 expected = 0x88e79c46cc0af369c6241b07f2b55e209dd5f7f708397dcbaebc54fa20c8ddf8;
        require(
            keccak256(abi.encode("MINDMARK_WORK_UNIT_PRICING_V1", vectorProjectId, rewards)) == expected,
            "pricing root vector mismatch"
        );
    }

    function testFundingRejectsWrongAmount() public {
        uint128[] memory rewards = _rewards();
        vm.prank(SPONSOR);
        vm.expectPartialRevert(LearningProjectEscrow.InvalidFundingAmount.selector);
        escrow.fundProject{value: REWARD_0}(PROJECT_ID, rewards);
    }

    function testFundingRejectsIncompleteQuoteSheet() public {
        uint128[] memory rewards = new uint128[](1);
        rewards[0] = REWARD_0;
        vm.prank(SPONSOR);
        vm.expectPartialRevert(LearningProjectEscrow.InvalidRewardCount.selector);
        escrow.fundProject{value: REWARD_0}(PROJECT_ID, rewards);
    }

    function testCannotReleaseBeforeRegistryCommitment() public {
        _fund();
        vm.prank(SPONSOR);
        vm.expectPartialRevert(LearningProjectEscrow.MissingWorkUnitCommitment.selector);
        escrow.releaseReward(PROJECT_ID, 0);
    }

    function testReleasePaysRegistryWorkerAndCannotRepeat() public {
        _fund();
        _commit(0, WORKER_0);
        uint256 workerBalanceBefore = WORKER_0.balance;

        vm.prank(SPONSOR);
        escrow.releaseReward(PROJECT_ID, 0);

        require(WORKER_0.balance == workerBalanceBefore + REWARD_0, "Worker was not paid");
        require(escrow.rewardReleased(PROJECT_ID, 0), "release not recorded");
        (,,, uint128 remainingBudget,, uint16 settledWorkUnitCount,,) = escrow.projectEscrows(PROJECT_ID);
        require(remainingBudget == REWARD_1, "remaining budget mismatch");
        require(settledWorkUnitCount == 1, "settled count mismatch");

        vm.prank(SPONSOR);
        vm.expectPartialRevert(LearningProjectEscrow.RewardAlreadyReleased.selector);
        escrow.releaseReward(PROJECT_ID, 0);
    }

    function testCancelledProjectRefundsOnlyUnsettledBudget() public {
        _fund();
        _commit(0, WORKER_0);
        vm.prank(SPONSOR);
        escrow.releaseReward(PROJECT_ID, 0);

        vm.prank(LEARNER);
        registry.cancelProject(PROJECT_ID);
        uint256 sponsorBalanceBefore = SPONSOR.balance;

        vm.prank(SPONSOR);
        escrow.refundCancelledProject(PROJECT_ID);

        require(SPONSOR.balance == sponsorBalanceBefore + REWARD_1, "unsettled budget was not refunded");
        (,,, uint128 remainingBudget,,,, bool refunded) = escrow.projectEscrows(PROJECT_ID);
        require(remainingBudget == 0 && refunded, "refund state mismatch");
    }

    function testDifferentWorkUnitsReceiveTheirFrozenRewards() public {
        _fund();
        _commit(1, WORKER_1);
        uint256 workerBalanceBefore = WORKER_1.balance;

        vm.prank(SPONSOR);
        escrow.releaseReward(PROJECT_ID, 1);

        require(WORKER_1.balance == workerBalanceBefore + REWARD_1, "dynamic reward mismatch");
    }

    function _fund() private {
        uint128[] memory rewards = _rewards();
        vm.prank(SPONSOR);
        escrow.fundProject{value: TOTAL_REWARD}(PROJECT_ID, rewards);
    }

    function _rewards() private pure returns (uint128[] memory rewards) {
        rewards = new uint128[](2);
        rewards[0] = REWARD_0;
        rewards[1] = REWARD_1;
    }

    function _createProject() private {
        LearningProjectRegistryV2.ChapterSeed[] memory seeds = new LearningProjectRegistryV2.ChapterSeed[](2);
        seeds[0] = LearningProjectRegistryV2.ChapterSeed({
            sourceHash: keccak256("escrow chapter 0"), firstWorkUnitId: 0, workUnitCount: 1
        });
        seeds[1] = LearningProjectRegistryV2.ChapterSeed({
            sourceHash: keccak256("escrow chapter 1"), firstWorkUnitId: 1, workUnitCount: 1
        });
        vm.prank(LEARNER);
        registry.createProject(
            PROJECT_ID, keccak256("source"), keccak256("goal"), keccak256("outline"), manifestRoot, seeds
        );
    }

    function _commit(uint16 workUnitId, address worker) private {
        bytes32[] memory proof = new bytes32[](1);
        proof[0] = manifestLeaves[workUnitId == 0 ? 1 : 0];
        vm.prank(worker);
        registry.commitWorkUnit(
            PROJECT_ID,
            workUnitId,
            workUnitId,
            sourceUnitHashes[workUnitId],
            keccak256(abi.encode("cards", workUnitId)),
            4,
            proof
        );
    }

    function _hashPair(bytes32 left, bytes32 right) private pure returns (bytes32) {
        return left < right ? keccak256(abi.encodePacked(left, right)) : keccak256(abi.encodePacked(right, left));
    }
}
