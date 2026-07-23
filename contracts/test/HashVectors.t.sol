// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";

interface Vm {
    function readFile(string calldata path) external returns (string memory data);
    function parseJson(string calldata json, string calldata key) external returns (bytes memory data);
    function parseJsonBytes32(string calldata json, string calldata key) external returns (bytes32 value);
    function parseJsonUint(string calldata json, string calldata key) external returns (uint256 value);
}

contract HashVectorsTest {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    function testManifestLeavesAndProofsMatchTypeScriptVector() public {
        string memory json = vm.readFile("fixtures/hash-vectors.json");
        bytes32 journeyId = vm.parseJsonBytes32(json, ".journeyId");
        bytes32 root = vm.parseJsonBytes32(json, ".chunkManifestRoot");

        _assertManifestEntry(json, journeyId, root, ".chunks[0]");
        _assertManifestEntry(json, journeyId, root, ".chunks[1]");
        _assertManifestEntry(json, journeyId, root, ".chunks[2]");
    }

    function testCardIdsAndProofsMatchTypeScriptVector() public {
        string memory json = vm.readFile("fixtures/hash-vectors.json");
        bytes32 journeyId = vm.parseJsonBytes32(json, ".journeyId");

        _assertCardEntry(json, journeyId, 0, ".chunks[0]", ".chunks[0].cards[0]");
        _assertCardEntry(json, journeyId, 0, ".chunks[0]", ".chunks[0].cards[1]");
        _assertCardEntry(json, journeyId, 1, ".chunks[1]", ".chunks[1].cards[0]");
        _assertCardEntry(json, journeyId, 1, ".chunks[1]", ".chunks[1].cards[1]");
        _assertCardEntry(json, journeyId, 2, ".chunks[2]", ".chunks[2].cards[0]");
        _assertCardEntry(json, journeyId, 2, ".chunks[2]", ".chunks[2].cards[1]");
    }

    function testDeckProofsMatchTypeScriptVector() public {
        string memory json = vm.readFile("fixtures/hash-vectors.json");
        bytes32 deckRoot = vm.parseJsonBytes32(json, ".deckRoot");

        _assertDeckEntry(json, deckRoot, 0);
        _assertDeckEntry(json, deckRoot, 1);
        _assertDeckEntry(json, deckRoot, 2);
        _assertDeckEntry(json, deckRoot, 3);
        _assertDeckEntry(json, deckRoot, 4);
        _assertDeckEntry(json, deckRoot, 5);
    }

    function testWrongProofFails() public {
        string memory json = vm.readFile("fixtures/hash-vectors.json");
        bytes32 root = vm.parseJsonBytes32(json, ".chunkManifestRoot");
        bytes32 leaf = vm.parseJsonBytes32(json, ".chunks[0].manifestLeaf");
        bytes32[] memory proof = _proof(json, ".chunks[0].manifestProof");
        proof[0] = bytes32(0);

        require(!MerkleProof.verify(proof, root, leaf), "wrong proof unexpectedly passed");
    }

    function _assertManifestEntry(string memory json, bytes32 journeyId, bytes32 root, string memory prefix) private {
        uint16 chunkId = uint16(vm.parseJsonUint(json, string.concat(prefix, ".chunkId")));
        bytes32 sourceChunkHash = vm.parseJsonBytes32(json, string.concat(prefix, ".sourceChunkHash"));
        bytes32 expectedLeaf = vm.parseJsonBytes32(json, string.concat(prefix, ".manifestLeaf"));
        bytes32 actualLeaf = keccak256(abi.encode(journeyId, chunkId, sourceChunkHash));
        bytes32[] memory proof = _proof(json, string.concat(prefix, ".manifestProof"));

        require(actualLeaf == expectedLeaf, "manifest leaf mismatch");
        require(MerkleProof.verify(proof, root, actualLeaf), "manifest proof mismatch");
    }

    function _assertCardEntry(
        string memory json,
        bytes32 journeyId,
        uint16 chunkId,
        string memory chunkPrefix,
        string memory cardPrefix
    ) private {
        bytes32 cardHash = vm.parseJsonBytes32(json, string.concat(cardPrefix, ".cardHash"));
        bytes32 expectedCardId = vm.parseJsonBytes32(json, string.concat(cardPrefix, ".cardId"));
        bytes32 cardsRoot = vm.parseJsonBytes32(json, string.concat(chunkPrefix, ".cardsRoot"));
        bytes32 actualCardId = keccak256(abi.encode(journeyId, chunkId, cardHash));
        bytes32[] memory cardProof = _proof(json, string.concat(cardPrefix, ".cardProof"));

        require(actualCardId == expectedCardId, "card id mismatch");
        require(MerkleProof.verify(cardProof, cardsRoot, actualCardId), "card proof mismatch");
    }

    function _assertDeckEntry(string memory json, bytes32 deckRoot, uint256 index) private {
        string memory prefix = string.concat(".deckProofs[", _digit(index), "]");
        bytes32 cardId = vm.parseJsonBytes32(json, string.concat(prefix, ".cardId"));
        bytes32[] memory proof = _proof(json, string.concat(prefix, ".proof"));
        require(MerkleProof.verify(proof, deckRoot, cardId), "deck proof mismatch");
    }

    function _proof(string memory json, string memory key) private returns (bytes32[] memory) {
        return abi.decode(vm.parseJson(json, key), (bytes32[]));
    }

    function _digit(uint256 value) private pure returns (string memory) {
        require(value < 10, "single digit only");
        bytes memory output = new bytes(1);
        output[0] = bytes1(uint8(48 + value));
        return string(output);
    }
}
