// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {LearningProjectEscrow} from "../src/LearningProjectEscrow.sol";

interface EscrowDeployVm {
    function envAddress(string calldata name) external returns (address value);
    function envUint(string calldata name) external returns (uint256 value);
    function startBroadcast(uint256 privateKey) external;
    function stopBroadcast() external;
}

contract DeployLearningProjectEscrow {
    EscrowDeployVm private constant vm = EscrowDeployVm(address(uint160(uint256(keccak256("hevm cheat code")))));

    function run() external returns (LearningProjectEscrow escrow) {
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address registry = vm.envAddress("REGISTRY_V2_ADDRESS");

        vm.startBroadcast(deployerKey);
        escrow = new LearningProjectEscrow(registry);
        vm.stopBroadcast();
    }
}
