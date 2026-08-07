// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {LearningCompletionRegistry} from "../src/LearningCompletionRegistry.sol";

interface CompletionVm {
    function envAddress(string calldata name) external returns (address value);
    function envUint(string calldata name) external returns (uint256 value);
    function startBroadcast(uint256 privateKey) external;
    function stopBroadcast() external;
}

contract DeployLearningCompletionRegistry {
    CompletionVm private constant vm = CompletionVm(address(uint160(uint256(keccak256("hevm cheat code")))));

    function run() external returns (LearningCompletionRegistry registry) {
        vm.startBroadcast(vm.envUint("DEPLOYER_PRIVATE_KEY"));
        registry = new LearningCompletionRegistry(
            vm.envAddress("REGISTRY_V2_ADDRESS"), vm.envAddress("COMPLETION_ATTESTOR_ADDRESS")
        );
        vm.stopBroadcast();
    }
}
