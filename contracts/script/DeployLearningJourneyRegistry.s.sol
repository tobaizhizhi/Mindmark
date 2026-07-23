// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {LearningJourneyRegistry} from "../src/LearningJourneyRegistry.sol";

interface Vm {
    function envAddress(string calldata name) external returns (address value);
    function envUint(string calldata name) external returns (uint256 value);
    function startBroadcast(uint256 privateKey) external;
    function stopBroadcast() external;
}

contract DeployLearningJourneyRegistry {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    function run() external returns (LearningJourneyRegistry registry) {
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address[3] memory workers =
            [vm.envAddress("WORKER_0_ADDRESS"), vm.envAddress("WORKER_1_ADDRESS"), vm.envAddress("WORKER_2_ADDRESS")];

        vm.startBroadcast(deployerKey);
        registry = new LearningJourneyRegistry(vm.envAddress("COORDINATOR_ADDRESS"), workers);
        vm.stopBroadcast();
    }
}

