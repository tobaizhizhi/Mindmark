export declare const learningJourneyRegistryAbi: readonly [{
    readonly name: "createJourney";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly type: "bytes32";
        readonly name: "journeyId";
    }, {
        readonly type: "bytes32";
        readonly name: "sourceHash";
    }, {
        readonly type: "bytes32";
        readonly name: "goalHash";
    }, {
        readonly type: "bytes32";
        readonly name: "chunkManifestRoot";
    }, {
        readonly type: "uint16";
        readonly name: "chunkCount";
    }];
    readonly outputs: readonly [];
}, {
    readonly name: "commitChunk";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly type: "bytes32";
        readonly name: "journeyId";
    }, {
        readonly type: "uint16";
        readonly name: "chunkId";
    }, {
        readonly type: "bytes32";
        readonly name: "sourceChunkHash";
    }, {
        readonly type: "bytes32";
        readonly name: "cardsRoot";
    }, {
        readonly type: "uint16";
        readonly name: "cardCount";
    }, {
        readonly type: "bytes32[]";
        readonly name: "manifestProof";
    }];
    readonly outputs: readonly [];
}, {
    readonly name: "finalizeDeck";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly type: "bytes32";
        readonly name: "journeyId";
    }, {
        readonly type: "bytes32";
        readonly name: "deckRoot";
    }, {
        readonly type: "bytes32";
        readonly name: "initialPlanHash";
    }, {
        readonly type: "uint16";
        readonly name: "totalCardCount";
    }];
    readonly outputs: readonly [];
}, {
    readonly name: "cancelJourney";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly type: "bytes32";
        readonly name: "journeyId";
    }];
    readonly outputs: readonly [];
}, {
    readonly name: "coordinator";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [];
    readonly outputs: readonly [{
        readonly type: "address";
    }];
}, {
    readonly name: "isWorker";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "worker";
    }];
    readonly outputs: readonly [{
        readonly type: "bool";
    }];
}, {
    readonly name: "journeys";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [{
        readonly type: "bytes32";
        readonly name: "journeyId";
    }];
    readonly outputs: readonly [{
        readonly type: "address";
        readonly name: "learner";
    }, {
        readonly type: "bytes32";
        readonly name: "sourceHash";
    }, {
        readonly type: "bytes32";
        readonly name: "goalHash";
    }, {
        readonly type: "bytes32";
        readonly name: "chunkManifestRoot";
    }, {
        readonly type: "bytes32";
        readonly name: "deckRoot";
    }, {
        readonly type: "bytes32";
        readonly name: "initialPlanHash";
    }, {
        readonly type: "uint16";
        readonly name: "chunkCount";
    }, {
        readonly type: "uint16";
        readonly name: "totalCardCount";
    }, {
        readonly type: "uint8";
        readonly name: "status";
    }];
}, {
    readonly name: "chunks";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [{
        readonly type: "bytes32";
        readonly name: "journeyId";
    }, {
        readonly type: "uint16";
        readonly name: "chunkId";
    }];
    readonly outputs: readonly [{
        readonly type: "bytes32";
        readonly name: "sourceChunkHash";
    }, {
        readonly type: "bytes32";
        readonly name: "cardsRoot";
    }, {
        readonly type: "address";
        readonly name: "agent";
    }, {
        readonly type: "uint64";
        readonly name: "committedBlock";
    }, {
        readonly type: "uint16";
        readonly name: "cardCount";
    }];
}, {
    readonly name: "JourneyCreated";
    readonly type: "event";
    readonly inputs: readonly [{
        readonly type: "bytes32";
        readonly name: "journeyId";
        readonly indexed: true;
    }, {
        readonly type: "address";
        readonly name: "learner";
        readonly indexed: true;
    }, {
        readonly type: "bytes32";
        readonly name: "sourceHash";
    }, {
        readonly type: "bytes32";
        readonly name: "goalHash";
    }, {
        readonly type: "bytes32";
        readonly name: "chunkManifestRoot";
    }, {
        readonly type: "uint16";
        readonly name: "chunkCount";
    }];
}, {
    readonly name: "ChunkCommitted";
    readonly type: "event";
    readonly inputs: readonly [{
        readonly type: "bytes32";
        readonly name: "journeyId";
        readonly indexed: true;
    }, {
        readonly type: "uint16";
        readonly name: "chunkId";
        readonly indexed: true;
    }, {
        readonly type: "address";
        readonly name: "agent";
        readonly indexed: true;
    }, {
        readonly type: "bytes32";
        readonly name: "sourceChunkHash";
    }, {
        readonly type: "bytes32";
        readonly name: "cardsRoot";
    }, {
        readonly type: "uint16";
        readonly name: "cardCount";
    }];
}, {
    readonly name: "DeckFinalized";
    readonly type: "event";
    readonly inputs: readonly [{
        readonly type: "bytes32";
        readonly name: "journeyId";
        readonly indexed: true;
    }, {
        readonly type: "bytes32";
        readonly name: "deckRoot";
    }, {
        readonly type: "bytes32";
        readonly name: "initialPlanHash";
    }, {
        readonly type: "uint16";
        readonly name: "totalCardCount";
    }];
}, {
    readonly name: "JourneyCancelled";
    readonly type: "event";
    readonly inputs: readonly [{
        readonly type: "bytes32";
        readonly name: "journeyId";
        readonly indexed: true;
    }, {
        readonly type: "address";
        readonly name: "learner";
        readonly indexed: true;
    }];
}];
