// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";

contract LearningProjectRegistryV2 {
    uint16 public constant MAX_CHAPTER_COUNT = 16;
    uint16 public constant MAX_WORK_UNIT_COUNT = 48;
    uint16 public constant MAX_CHAPTER_WORK_UNITS = 8;
    uint16 public constant MAX_CARD_COUNT = 200;
    uint16 public constant MAX_WORK_UNIT_CARD_COUNT = 30;

    enum ProjectStatus {
        NONE,
        CREATED,
        READY,
        CANCELLED
    }

    enum ChapterStatus {
        NONE,
        OPEN,
        READY
    }

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
        ProjectStatus status;
    }

    struct ChapterSeed {
        bytes32 sourceHash;
        uint16 firstWorkUnitId;
        uint16 workUnitCount;
    }

    struct Chapter {
        bytes32 sourceHash;
        bytes32 cardsRoot;
        uint16 firstWorkUnitId;
        uint16 workUnitCount;
        uint16 cardCount;
        ChapterStatus status;
    }

    struct WorkUnitCommitment {
        uint16 chapterId;
        bytes32 sourceUnitHash;
        bytes32 workerCardsRoot;
        address worker;
        uint64 committedBlock;
        uint16 cardCount;
    }

    error EmptyValue();
    error InvalidChapterCount(uint16 count);
    error InvalidWorkUnitCount(uint16 count);
    error InvalidChapterSeed(uint16 chapterId);
    error InvalidCardCount(uint16 count);
    error DuplicateAddress();
    error ProjectAlreadyExists(bytes32 projectId);
    error ProjectNotCreated(bytes32 projectId);
    error InvalidProjectState(bytes32 projectId, ProjectStatus status);
    error UnauthorizedWorker(address caller);
    error UnauthorizedCoordinator(address caller);
    error UnauthorizedLearner(address caller);
    error ChapterOutOfRange(uint16 chapterId);
    error WorkUnitOutOfRange(uint16 workUnitId);
    error WorkUnitChapterMismatch(uint16 workUnitId, uint16 expectedChapterId, uint16 actualChapterId);
    error WorkUnitAlreadyCommitted(uint16 workUnitId);
    error InvalidManifestProof(uint16 workUnitId);
    error MissingWorkUnit(uint16 workUnitId);
    error ChapterAlreadyFinalized(uint16 chapterId);
    error MissingChapter(uint16 chapterId);
    error FinalCardCountExceedsGenerated(uint16 selected, uint256 generated);
    error ProjectNotComplete();

    event ProjectCreated(
        bytes32 indexed projectId,
        address indexed learner,
        bytes32 sourceHash,
        bytes32 outlineHash,
        uint16 chapterCount,
        uint16 workUnitCount
    );
    event WorkUnitCommitted(
        bytes32 indexed projectId,
        uint16 indexed chapterId,
        uint16 indexed workUnitId,
        address worker,
        bytes32 sourceUnitHash,
        bytes32 workerCardsRoot,
        uint16 cardCount
    );
    event ChapterFinalized(bytes32 indexed projectId, uint16 indexed chapterId, bytes32 cardsRoot, uint16 cardCount);
    event ProjectFinalized(bytes32 indexed projectId, bytes32 projectDeckRoot, bytes32 initialPlanHash, uint16 totalCardCount);
    event ProjectCancelled(bytes32 indexed projectId, address indexed learner);

    address public immutable coordinator;
    address public immutable worker0;
    address public immutable worker1;
    address public immutable worker2;

    mapping(address worker => bool allowed) public isWorker;
    mapping(bytes32 projectId => Project project) public projects;
    mapping(bytes32 projectId => mapping(uint16 chapterId => Chapter chapter)) public chapters;
    mapping(bytes32 projectId => mapping(uint16 workUnitId => WorkUnitCommitment commitment)) public workUnits;

    constructor(address coordinator_, address[3] memory workers_) {
        if (
            coordinator_ == address(0) || workers_[0] == address(0) || workers_[1] == address(0)
                || workers_[2] == address(0)
        ) revert EmptyValue();
        if (
            coordinator_ == workers_[0] || coordinator_ == workers_[1] || coordinator_ == workers_[2]
                || workers_[0] == workers_[1] || workers_[0] == workers_[2] || workers_[1] == workers_[2]
        ) revert DuplicateAddress();

        coordinator = coordinator_;
        worker0 = workers_[0];
        worker1 = workers_[1];
        worker2 = workers_[2];
        isWorker[workers_[0]] = true;
        isWorker[workers_[1]] = true;
        isWorker[workers_[2]] = true;
    }

    function createProject(
        bytes32 projectId,
        bytes32 sourceHash,
        bytes32 goalHash,
        bytes32 outlineHash,
        bytes32 workUnitManifestRoot,
        ChapterSeed[] calldata seeds
    ) external {
        if (
            projectId == bytes32(0) || sourceHash == bytes32(0) || goalHash == bytes32(0)
                || outlineHash == bytes32(0) || workUnitManifestRoot == bytes32(0)
        ) revert EmptyValue();
        if (seeds.length == 0 || seeds.length > MAX_CHAPTER_COUNT) {
            revert InvalidChapterCount(uint16(seeds.length));
        }
        if (projects[projectId].status != ProjectStatus.NONE) revert ProjectAlreadyExists(projectId);

        uint256 totalWorkUnits;
        for (uint16 chapterId = 0; chapterId < seeds.length; ++chapterId) {
            ChapterSeed calldata seed = seeds[chapterId];
            if (
                seed.sourceHash == bytes32(0) || seed.workUnitCount == 0
                    || seed.workUnitCount > MAX_CHAPTER_WORK_UNITS
                    || uint256(seed.firstWorkUnitId) + seed.workUnitCount > MAX_WORK_UNIT_COUNT
            ) revert InvalidChapterSeed(chapterId);
            if (chapterId > 0) {
                ChapterSeed calldata previous = seeds[chapterId - 1];
                if (seed.firstWorkUnitId != previous.firstWorkUnitId + previous.workUnitCount) {
                    revert InvalidChapterSeed(chapterId);
                }
            } else if (seed.firstWorkUnitId != 0) {
                revert InvalidChapterSeed(chapterId);
            }
            totalWorkUnits += seed.workUnitCount;
        }
        if (totalWorkUnits == 0 || totalWorkUnits > MAX_WORK_UNIT_COUNT) {
            revert InvalidWorkUnitCount(uint16(totalWorkUnits));
        }

        projects[projectId] = Project({
            learner: msg.sender,
            sourceHash: sourceHash,
            goalHash: goalHash,
            outlineHash: outlineHash,
            workUnitManifestRoot: workUnitManifestRoot,
            projectDeckRoot: bytes32(0),
            initialPlanHash: bytes32(0),
            chapterCount: uint16(seeds.length),
            workUnitCount: uint16(totalWorkUnits),
            totalCardCount: 0,
            status: ProjectStatus.CREATED
        });

        for (uint16 chapterId = 0; chapterId < seeds.length; ++chapterId) {
            ChapterSeed calldata seed = seeds[chapterId];
            chapters[projectId][chapterId] = Chapter({
                sourceHash: seed.sourceHash,
                cardsRoot: bytes32(0),
                firstWorkUnitId: seed.firstWorkUnitId,
                workUnitCount: seed.workUnitCount,
                cardCount: 0,
                status: ChapterStatus.OPEN
            });
        }

        emit ProjectCreated(projectId, msg.sender, sourceHash, outlineHash, uint16(seeds.length), uint16(totalWorkUnits));
    }

    function commitWorkUnit(
        bytes32 projectId,
        uint16 workUnitId,
        uint16 chapterId,
        bytes32 sourceUnitHash,
        bytes32 workerCardsRoot,
        uint16 cardCount,
        bytes32[] calldata manifestProof
    ) external {
        if (!isWorker[msg.sender]) revert UnauthorizedWorker(msg.sender);
        Project storage project = projects[projectId];
        if (project.status == ProjectStatus.NONE) revert ProjectNotCreated(projectId);
        if (project.status != ProjectStatus.CREATED) revert InvalidProjectState(projectId, project.status);
        if (chapterId >= project.chapterCount) revert ChapterOutOfRange(chapterId);
        if (workUnitId >= project.workUnitCount) revert WorkUnitOutOfRange(workUnitId);
        Chapter storage chapter = chapters[projectId][chapterId];
        if (workUnitId < chapter.firstWorkUnitId || workUnitId >= chapter.firstWorkUnitId + chapter.workUnitCount) {
            revert WorkUnitChapterMismatch(workUnitId, chapterId, chapterId);
        }
        if (sourceUnitHash == bytes32(0) || workerCardsRoot == bytes32(0)) revert EmptyValue();
        if (cardCount == 0 || cardCount > MAX_WORK_UNIT_CARD_COUNT) revert InvalidCardCount(cardCount);
        if (workUnits[projectId][workUnitId].worker != address(0)) revert WorkUnitAlreadyCommitted(workUnitId);

        bytes32 leaf = keccak256(abi.encode("MINDMARK_WORK_UNIT_V2", projectId, chapterId, workUnitId, sourceUnitHash));
        if (!MerkleProof.verifyCalldata(manifestProof, project.workUnitManifestRoot, leaf)) {
            revert InvalidManifestProof(workUnitId);
        }

        workUnits[projectId][workUnitId] = WorkUnitCommitment({
            chapterId: chapterId,
            sourceUnitHash: sourceUnitHash,
            workerCardsRoot: workerCardsRoot,
            worker: msg.sender,
            committedBlock: uint64(block.number),
            cardCount: cardCount
        });

        emit WorkUnitCommitted(
            projectId, chapterId, workUnitId, msg.sender, sourceUnitHash, workerCardsRoot, cardCount
        );
    }

    function finalizeChapter(bytes32 projectId, uint16 chapterId, bytes32 chapterCardsRoot, uint16 selectedCardCount)
        external
    {
        if (msg.sender != coordinator) revert UnauthorizedCoordinator(msg.sender);
        Project storage project = projects[projectId];
        if (project.status == ProjectStatus.NONE) revert ProjectNotCreated(projectId);
        if (project.status != ProjectStatus.CREATED) revert InvalidProjectState(projectId, project.status);
        if (chapterId >= project.chapterCount) revert ChapterOutOfRange(chapterId);
        Chapter storage chapter = chapters[projectId][chapterId];
        if (chapter.status == ChapterStatus.READY) revert ChapterAlreadyFinalized(chapterId);
        if (chapterCardsRoot == bytes32(0)) revert EmptyValue();
        if (selectedCardCount == 0 || selectedCardCount > MAX_WORK_UNIT_CARD_COUNT * chapter.workUnitCount) {
            revert InvalidCardCount(selectedCardCount);
        }

        uint256 generatedCardCount;
        for (uint16 offset = 0; offset < chapter.workUnitCount; ++offset) {
            uint16 workUnitId = chapter.firstWorkUnitId + offset;
            WorkUnitCommitment storage commitment = workUnits[projectId][workUnitId];
            if (commitment.worker == address(0)) revert MissingWorkUnit(workUnitId);
            generatedCardCount += commitment.cardCount;
        }
        if (selectedCardCount > generatedCardCount) {
            revert FinalCardCountExceedsGenerated(selectedCardCount, generatedCardCount);
        }

        chapter.cardsRoot = chapterCardsRoot;
        chapter.cardCount = selectedCardCount;
        chapter.status = ChapterStatus.READY;
        emit ChapterFinalized(projectId, chapterId, chapterCardsRoot, selectedCardCount);
    }

    function finalizeProject(bytes32 projectId, bytes32 projectDeckRoot, bytes32 initialPlanHash, uint16 totalCardCount)
        external
    {
        if (msg.sender != coordinator) revert UnauthorizedCoordinator(msg.sender);
        Project storage project = projects[projectId];
        if (project.status == ProjectStatus.NONE) revert ProjectNotCreated(projectId);
        if (project.status != ProjectStatus.CREATED) revert InvalidProjectState(projectId, project.status);
        if (projectDeckRoot == bytes32(0) || initialPlanHash == bytes32(0)) revert EmptyValue();
        if (totalCardCount == 0 || totalCardCount > MAX_CARD_COUNT) revert InvalidCardCount(totalCardCount);

        uint256 chapterCardCount;
        for (uint16 chapterId = 0; chapterId < project.chapterCount; ++chapterId) {
            Chapter storage chapter = chapters[projectId][chapterId];
            if (chapter.status != ChapterStatus.READY) revert MissingChapter(chapterId);
            chapterCardCount += chapter.cardCount;
        }
        if (totalCardCount > chapterCardCount) revert FinalCardCountExceedsGenerated(totalCardCount, chapterCardCount);

        project.projectDeckRoot = projectDeckRoot;
        project.initialPlanHash = initialPlanHash;
        project.totalCardCount = totalCardCount;
        project.status = ProjectStatus.READY;
        emit ProjectFinalized(projectId, projectDeckRoot, initialPlanHash, totalCardCount);
    }

    function cancelProject(bytes32 projectId) external {
        Project storage project = projects[projectId];
        if (project.status == ProjectStatus.NONE) revert ProjectNotCreated(projectId);
        if (msg.sender != project.learner) revert UnauthorizedLearner(msg.sender);
        if (project.status != ProjectStatus.CREATED) revert InvalidProjectState(projectId, project.status);
        project.status = ProjectStatus.CANCELLED;
        emit ProjectCancelled(projectId, msg.sender);
    }
}
