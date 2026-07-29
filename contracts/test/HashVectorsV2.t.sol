// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

interface VmV2 {
    function readFile(string calldata path) external returns (string memory data);
    function parseJsonBytes32(string calldata json, string calldata key) external returns (bytes32 value);
    function parseJsonString(string calldata json, string calldata key) external returns (string memory value);
    function parseJsonUint(string calldata json, string calldata key) external returns (uint256 value);
}

contract HashVectorsV2Test {
    VmV2 private constant vm = VmV2(address(uint160(uint256(keccak256("hevm cheat code")))));

    function testV2TitleHashAndOutlineLeafMatchTypeScriptVector() public {
        string memory json = vm.readFile("fixtures/hash-vectors-v2.json");
        bytes32 projectId = vm.parseJsonBytes32(json, ".projectId");
        uint16 chapterId = uint16(vm.parseJsonUint(json, ".chapterId"));
        string memory title = vm.parseJsonString(json, ".title");
        bytes32 sourceHash = vm.parseJsonBytes32(json, ".sourceHash");
        bytes32 titleHash = keccak256(bytes(title));
        bytes32 outlineLeaf = keccak256(
            abi.encode("MINDMARK_OUTLINE_V2", projectId, chapterId, titleHash, sourceHash)
        );

        require(titleHash == vm.parseJsonBytes32(json, ".titleHash"), "title hash mismatch");
        require(outlineLeaf == vm.parseJsonBytes32(json, ".outlineLeaf"), "outline leaf mismatch");
    }

    function testV2WorkUnitLeafMatchesTypeScriptVector() public {
        string memory json = vm.readFile("fixtures/hash-vectors-v2.json");
        bytes32 workUnitLeaf = keccak256(
            abi.encode(
                "MINDMARK_WORK_UNIT_V2",
                vm.parseJsonBytes32(json, ".projectId"),
                uint16(vm.parseJsonUint(json, ".chapterId")),
                uint16(vm.parseJsonUint(json, ".workUnitId")),
                vm.parseJsonBytes32(json, ".sourceUnitHash")
            )
        );
        require(workUnitLeaf == vm.parseJsonBytes32(json, ".workUnitLeaf"), "work unit leaf mismatch");
    }

    function testV2CardIdMatchesTypeScriptVector() public {
        string memory json = vm.readFile("fixtures/hash-vectors-v2.json");
        bytes32 cardId = keccak256(
            abi.encode(
                "MINDMARK_CARD_V2",
                vm.parseJsonBytes32(json, ".projectId"),
                uint16(vm.parseJsonUint(json, ".chapterId")),
                uint16(vm.parseJsonUint(json, ".workUnitId")),
                vm.parseJsonBytes32(json, ".cardHash")
            )
        );
        require(cardId == vm.parseJsonBytes32(json, ".cardId"), "card id mismatch");
    }

    function testV2ChapterLeafMatchesTypeScriptVector() public {
        string memory json = vm.readFile("fixtures/hash-vectors-v2.json");
        bytes32 chapterLeaf = keccak256(
            abi.encode(
                "MINDMARK_CHAPTER_V2",
                vm.parseJsonBytes32(json, ".projectId"),
                uint16(vm.parseJsonUint(json, ".chapterId")),
                vm.parseJsonBytes32(json, ".cardsRoot"),
                uint16(vm.parseJsonUint(json, ".cardCount"))
            )
        );
        require(chapterLeaf == vm.parseJsonBytes32(json, ".chapterLeaf"), "chapter leaf mismatch");
    }

    function testV1EncodingCannotReplayAsV2WorkUnit() public {
        string memory json = vm.readFile("fixtures/hash-vectors-v2.json");
        bytes32 projectId = vm.parseJsonBytes32(json, ".projectId");
        uint16 chapterId = uint16(vm.parseJsonUint(json, ".chapterId"));
        uint16 workUnitId = uint16(vm.parseJsonUint(json, ".workUnitId"));
        bytes32 sourceUnitHash = vm.parseJsonBytes32(json, ".sourceUnitHash");

        bytes32 v1StyleLeaf = keccak256(abi.encode(projectId, workUnitId, sourceUnitHash));
        bytes32 v2Leaf = keccak256(
            abi.encode("MINDMARK_WORK_UNIT_V2", projectId, chapterId, workUnitId, sourceUnitHash)
        );
        require(v1StyleLeaf != v2Leaf, "V1 leaf replayed as V2");
    }
}
