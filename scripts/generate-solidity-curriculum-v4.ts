import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

type CodeType = "code_read" | "code_complete" | "code_write";

type CodeSpec = {
  type: CodeType;
  question: string;
  answer: string;
  keyPoint: string;
  starterCode: string;
  solutionCode: string;
  testInput: string;
  expectedResult: string;
  hints: string[];
};

type Lesson = {
  slug: string;
  title: string;
  summary: string;
  minutes: number;
  stageId: number;
  stageTitle: string;
  newConcepts: string[];
  prerequisiteConcepts: string[];
  objectives: string[];
  practiceFocus: string;
  projectMilestone: string;
  sourceUrl: string;
  sourceLocator: string;
  concept: { question: string; answer: string; keyPoint: string; tags: string[] };
  check: { question: string; answer: string; keyPoint: string; tags: string[] };
  code: [CodeSpec, CodeSpec, CodeSpec];
  application: { question: string; answer: string; keyPoint: string; tags: string[] };
  misconception: { question: string; answer: string; keyPoint: string; tags: string[] };
};

const source = "https://docs.soliditylang.org/en/latest/";

const lessons: Lesson[] = [
  {
    slug: "contract-shell", title: "01 合约外壳：从源码到链上实例", summary: "只学习 pragma、contract、状态变量和 Remix 的编译部署闭环。", minutes: 18,
    stageId: 0, stageTitle: "阶段一：看见合约", newConcepts: ["pragma", "contract", "状态变量", "string", "public getter", "编译与部署"], prerequisiteConcepts: [],
    objectives: ["能解释源码、ABI、bytecode 和实例地址的关系", "能在 Remix 编译并部署 LearningRegistry", "能读取一个 public 状态变量"], practiceFocus: "只观察部署和读取，不引入函数、权限或 Ether。", projectMilestone: "创建 LearningRegistry 外壳，保存 registryName = Mindmark。", sourceUrl: `${source}structure-of-a-contract.html`, sourceLocator: "Structure of a Contract",
    concept: { question: "Solidity 源码、ABI、bytecode 和已部署合约分别是什么？", answer: "源码是人写的文本；编译器把它变成 bytecode 和描述调用形状的 ABI；部署交易把 bytecode 写成链上实例，实例由地址定位。", keyPoint: "编译成功不代表实例已经部署，四个对象要分开排查。", tags: ["pragma", "contract", "Remix"] },
    check: { question: "为什么第一次练习只读 public 状态变量，不马上写函数？", answer: "public 状态变量会自动生成 getter，能让学习者先观察部署结果和链上读取，减少同时理解参数、可见性和状态修改的负担。", keyPoint: "先建立可观察闭环，再逐层增加语法。", tags: ["学习路径", "getter", "部署"] },
    code: [
      { type: "code_read", question: "阅读 RegistryShell，部署后 getter 会返回什么？", answer: "registryName 的初值是 Mindmark；public 变量会生成同名 getter，读取不改变状态。", keyPoint: "状态变量初始化发生在部署实例创建时。", starterCode: "pragma solidity ^0.8.20;\ncontract RegistryShell {\n    string public registryName = \"Mindmark\";\n}", solutionCode: "部署 RegistryShell 后调用 registryName()，返回 Mindmark。", testInput: "部署合约并调用 registryName()。", expectedResult: "返回 Mindmark。", hints: ["先找状态变量的初值。", "public 会生成 getter。"] },
      { type: "code_complete", question: "补全 LearningRegistry 的 public name 和 version 初值。", answer: "声明 string public name = \"LearningRegistry\"，uint256 public version = 1。", keyPoint: "先用最少的状态表达项目名称和版本。", starterCode: "pragma solidity ^0.8.20;\ncontract LearningRegistry {\n    // TODO: name 和 version\n}", solutionCode: "pragma solidity ^0.8.20;\ncontract LearningRegistry {\n    string public name = \"LearningRegistry\";\n    uint256 public version = 1;\n}", testInput: "部署并读取 name() 与 version()。", expectedResult: "LearningRegistry 和 1。", hints: ["先写类型，再写 public。", "初始化值写在声明右侧。"] },
      { type: "code_write", question: "独立写一个 RegistryShell，包含 public title 和 active 两个状态变量。", answer: "title 使用 string，active 使用 bool，并在声明处分别设为 Solidity Learning 与 true。", keyPoint: "能独立写出可部署的最小合约，才进入函数层。", starterCode: "// 写出一个只包含 title 和 active 的最小合约\n", solutionCode: "pragma solidity ^0.8.20;\ncontract RegistryShell {\n    string public title = \"Solidity Learning\";\n    bool public active = true;\n}", testInput: "部署后读取 title 和 active。", expectedResult: "Solidity Learning、true。", hints: ["合约前写 pragma。", "两个状态变量都标记 public。"] },
    ],
    application: { question: "为什么把部署和读取分成两个操作有助于理解区块链？", answer: "部署是创建实例的交易，读取是对实例的 eth_call；把两者分开，能准确知道哪一步产生地址、哪一步只读取状态。", keyPoint: "执行模型清楚后，后面学习写入和 gas 才有基准。", tags: ["执行模型", "eth_call", "应用"] },
    misconception: { question: "误区：Solidity 文件名就是链上合约名，为什么不对？", answer: "链上识别合约依靠 bytecode 和地址，contract 声明名参与编译和 ABI，文件名本身不是运行时身份。", keyPoint: "文件、合约声明和地址是不同层次。", tags: ["文件名", "地址", "误区"] },
  },
  {
    slug: "value-types", title: "02 值类型：把数据含义写进类型", summary: "只处理 bool、uint、int、address、bytes 和 enum，不引入数组或 mapping。", minutes: 22,
    stageId: 0, stageTitle: "阶段一：看见合约", newConcepts: ["bool", "uint/int", "address", "bytes", "enum"], prerequisiteConcepts: ["pragma", "contract", "状态变量"],
    objectives: ["能为状态选择合适的值类型", "能解释值类型赋值会复制数据", "能识别零地址和整数范围边界"], practiceFocus: "使用独立值变量描述 Registry 的状态，不创建集合。", projectMilestone: "给 Registry 增加 active、version、admin 和 lifecycle。", sourceUrl: `${source}types.html`, sourceLocator: "Value Types",
    concept: { question: "为什么 address、uint256 和 enum 不能互相随意替代？", answer: "类型记录业务含义和运算规则：address 表示账户，uint256 表示非负数量，enum 表示有限状态集合。类型越准确，编译器越能提前发现错误。", keyPoint: "类型不是装饰，而是合约不变量的第一层表达。", tags: ["类型", "address", "enum"] },
    check: { question: "值类型赋值后修改新变量，为什么不会改变原变量？", answer: "值类型赋值会复制具体数据；只有引用类型在特定数据位置下才可能共享同一存储对象。", keyPoint: "先掌握复制语义，再学习 storage、memory、calldata。", tags: ["复制", "值类型", "数据位置"] },
    code: [
      { type: "code_read", question: "推断 ValueBoard 刚部署时的读取结果。", answer: "active=false、limit=0、admin=address(0)、phase=Draft；这是值类型零值和 enum 第一项。", keyPoint: "默认值确定但不一定符合业务要求。", starterCode: "enum Phase { Draft, Published }\nbool public active;\nuint256 public limit;\naddress public admin;\nPhase public phase;", solutionCode: "active=false；limit=0；admin=address(0)；phase=Phase.Draft。", testInput: "刚部署，不调用任何函数。", expectedResult: "返回 false、0、零地址、Draft。", hints: ["逐个看变量类型。", "enum 从第一个成员开始。"] },
      { type: "code_complete", question: "补全 setLimit，拒绝 0 并保存新的 uint256 上限。", answer: "先 require(next > 0)，再 limit = next；这里暂不加入 owner 权限。", keyPoint: "先练习值边界，权限会在后续章节单独引入。", starterCode: "uint256 public limit;\nfunction setLimit(uint256 next) external {\n    // TODO\n}", solutionCode: "uint256 public limit;\nfunction setLimit(uint256 next) external {\n    require(next > 0, \"zero limit\");\n    limit = next;\n}", testInput: "setLimit(0) 和 setLimit(10)。", expectedResult: "0 回滚，10 成功。", hints: ["require 放在写入前。", "next 是 uint256。"] },
      { type: "code_write", question: "写一个 PhaseBoard，使用 enum 表示 Draft、Review、Published，并提供 publish。", answer: "声明 enum Stage，状态变量 stage 默认 Draft，publish 把它设置为 Published。", keyPoint: "enum 适合有限且可读的生命周期。", starterCode: "// 写出 enum、状态变量和 publish()\n", solutionCode: "pragma solidity ^0.8.20;\ncontract PhaseBoard {\n    enum Stage { Draft, Review, Published }\n    Stage public stage;\n    function publish() external { stage = Stage.Published; }\n}", testInput: "读取初始 stage，再调用 publish。", expectedResult: "初始 Draft，之后 Published。", hints: ["enum 第一个成员是默认值。", "赋值使用 Stage.Published。"] },
    ],
    application: { question: "为什么把 lifecycle 写成 enum 比写成 magic number 更容易学习和审计？", answer: "enum 让每个数值有明确名字，代码读者不用猜 0、1、2 代表什么，也能减少非法状态的表达空间。", keyPoint: "可读性本身就是安全和学习效率。", tags: ["enum", "可读性", "应用"] },
    misconception: { question: "误区：private 值类型就不会被链上看到，为什么错误？", answer: "private 只限制 Solidity 源码中的名称访问，storage 仍公开可读；它不是加密。", keyPoint: "可见性、不可变性和隐私是三个不同概念。", tags: ["private", "隐私", "误区"] },
  },
  {
    slug: "function-signatures", title: "03 函数签名：让合约能够被调用", summary: "先学习参数、返回值和可见性，再学习函数能否读写状态。", minutes: 24,
    stageId: 0, stageTitle: "阶段一：看见合约", newConcepts: ["function", "参数", "external/public", "返回值签名", "msg.sender 上下文"], prerequisiteConcepts: ["uint/int", "address", "public getter"],
    objectives: ["能写带值类型参数的函数签名", "能区分 external、public、internal、private 的入口范围", "能按 ABI 顺序传参与接收返回值"], practiceFocus: "函数只接受和返回值类型，暂时不使用 mapping、struct 或 payable。", projectMilestone: "为 Registry 增加 rename、setLimit 和 readSummary 接口。", sourceUrl: `${source}contracts.html#functions`, sourceLocator: "Function Visibility and Function Types",
    concept: { question: "函数签名中的可见性解决什么问题？", answer: "可见性规定函数能否从外部消息调用、能否被内部代码调用；它不自动表示业务权限，external 函数仍可能被任何地址调用。", keyPoint: "入口范围和调用资格必须分开设计。", tags: ["function", "external", "ABI"] },
    check: { question: "为什么同一个函数的参数顺序必须稳定？", answer: "ABI 按签名和参数顺序编码 calldata；顺序改变会改变函数选择器后的数据布局，调用者就会得到错误或回滚。", keyPoint: "ABI 是跨前端和合约边界的严格契约。", tags: ["ABI", "参数", "调用"] },
    code: [
      { type: "code_read", question: "判断 Registry API 中哪些函数可以从浏览器直接调用。", answer: "external 和 public 都能被外部调用；internal 和 private 只能从合约内部路径调用。", keyPoint: "先看可见性，再看函数体的状态影响。", starterCode: "function rename(string calldata next) external { }\nfunction currentName() public view returns (string memory) { }\nfunction helper() internal pure returns (uint256) { return 1; }\nfunction secret() private pure returns (uint256) { return 2; }", solutionCode: "浏览器可直接调用 rename 和 currentName；helper、secret 没有外部入口。", testInput: "在 Remix 的 ABI 面板查看函数。", expectedResult: "只出现 external/public 函数。", hints: ["public/external 是外部可见性。", "private 不是隐私。"] },
      { type: "code_complete", question: "补全 rename，让它接收 string calldata 并写入 name。", answer: "函数参数使用 string calldata next，函数体执行 name = next。", keyPoint: "复杂类型的 data location 会在下一章详细展开，这里先照模板使用 calldata。", starterCode: "string public name;\nfunction rename(/* TODO */) external {\n    // TODO\n}", solutionCode: "string public name;\nfunction rename(string calldata next) external {\n    name = next;\n}", testInput: "rename(\"Alice\") 后读取 name。", expectedResult: "返回 Alice。", hints: ["参数类型写 string calldata。", "写入状态变量 name。"] },
      { type: "code_write", question: "写一个 Summary 合约，提供 setValues(uint256,uint256) 和 values() 返回两个值。", answer: "保存 first、second；setValues 写入它们；values 声明 returns (uint256,uint256) 并按顺序返回。", keyPoint: "函数签名把输入输出固定下来，后续才能组合调用。", starterCode: "// 写出两个状态变量、写函数和双返回值读取函数\n", solutionCode: "pragma solidity ^0.8.20;\ncontract Summary {\n    uint256 public first;\n    uint256 public second;\n    function setValues(uint256 a, uint256 b) external { first = a; second = b; }\n    function values() external view returns (uint256, uint256) { return (first, second); }\n}", testInput: "setValues(3, 8)，再调用 values。", expectedResult: "返回 (3, 8)。", hints: ["返回值用 returns 声明。", "顺序必须和签名一致。"] },
    ],
    application: { question: "为什么先学函数签名，再学状态可变性？", answer: "签名先解决‘怎么调用’；view、pure、payable 再解决‘调用会不会读写状态或接收价值’，分层后错误更容易定位。", keyPoint: "把 API 形状和执行效果拆开学习。", tags: ["学习路径", "API", "应用"] },
    misconception: { question: "误区：external 就等于只有管理员可以调用，为什么错误？", answer: "external 只说明可以从外部消息入口调用，任何地址都可能发起调用；管理员资格需要后续的权限检查。", keyPoint: "可见性不是授权。", tags: ["external", "授权", "误区"] },
  },
  {
    slug: "read-write-mutability", title: "04 读写函数：view、pure 与返回值", summary: "建立读状态、纯计算、写状态三条清晰路径。", minutes: 24,
    stageId: 0, stageTitle: "阶段一：看见合约", newConcepts: ["view", "pure", "return", "状态写入", "require 输入检查"], prerequisiteConcepts: ["function", "参数", "返回值签名"],
    objectives: ["能正确标注 view、pure 和普通写函数", "能区分 eth_call 与交易", "能写单值和多值返回函数"], practiceFocus: "LearningRegistry 只维护数值和文本，不处理 Ether 或集合。", projectMilestone: "增加 readSummary 和 incrementVersion，能观察读写差异。", sourceUrl: `${source}contracts.html#state-mutability`, sourceLocator: "State Mutability",
    concept: { question: "view 和 pure 的边界是什么？", answer: "view 可以读取状态但不能修改；pure 既不能读取也不能修改状态，只能依赖参数和局部计算。", keyPoint: "修饰符是执行承诺，函数体必须与承诺一致。", tags: ["view", "pure", "状态"] },
    check: { question: "为什么调用 view 通常不需要发送交易，但写函数需要？", answer: "view 通过 eth_call 在节点本地执行，不提交状态改变；写函数必须由交易执行并等待共识确认。", keyPoint: "调用方式决定用户体验，但写入仍要承担 gas 和确认等待。", tags: ["eth_call", "交易", "gas"] },
    code: [
      { type: "code_read", question: "给四个函数分类：纯计算、读状态、写状态。", answer: "double 是 pure；readVersion 是 view；bumpVersion 和 rename 都是写状态的普通函数。", keyPoint: "先看修饰符，再检查函数体是否违约。", starterCode: "uint256 public version;\nfunction double(uint256 x) external pure returns (uint256) { return x * 2; }\nfunction readVersion() external view returns (uint256) { return version; }\nfunction bumpVersion() external { version += 1; }\nfunction rename(string calldata next) external { name = next; }", solutionCode: "double -> pure；readVersion -> view；bumpVersion/rename -> 写状态交易。", testInput: "从 Remix 分别点击四个函数。", expectedResult: "前两个读取结果，后两个要求交易并改变状态。", hints: ["看函数体里的赋值。", "pure 不读状态。"] },
      { type: "code_complete", question: "补全 average，让它以 pure 函数返回两个整数的平均值。", answer: "声明 external pure returns (uint256)，return (a + b) / 2。", keyPoint: "先确认函数不访问状态，再选择 pure。", starterCode: "function average(uint256 a, uint256 b) external /* TODO */ returns (uint256) {\n    // TODO\n}", solutionCode: "function average(uint256 a, uint256 b) external pure returns (uint256) {\n    return (a + b) / 2;\n}", testInput: "average(7, 4)。", expectedResult: "返回 5，整数除法向下取整。", hints: ["只依赖 a、b。", "使用 / 2。"] },
      { type: "code_write", question: "写一个 VersionedRegistry：提供 ownerless 的 bump 和 view current，bump 每次增加 1。", answer: "version 初值为 0；bump 执行 version += 1；current 用 view returns 返回 version。", keyPoint: "先练习状态转换，不在这一章提前引入权限。", starterCode: "// 写出 version、bump() 和 current()\n", solutionCode: "pragma solidity ^0.8.20;\ncontract VersionedRegistry {\n    uint256 public version;\n    function bump() external { version += 1; }\n    function current() external view returns (uint256) { return version; }\n}", testInput: "调用 bump 两次，再 current。", expectedResult: "返回 2。", hints: ["写函数不能标记 view。", "current 只读取状态。"] },
    ],
    application: { question: "为什么把读函数写成 view 能帮助前端和审计者？", answer: "view 明确表示不会直接修改状态，前端可以用 eth_call，审计者也能快速隔离状态改变路径。", keyPoint: "清晰的状态边界降低误调用和审计成本。", tags: ["view", "前端", "审计"] },
    misconception: { question: "误区：pure 函数永远不会消耗 gas，为什么不严谨？", answer: "单独 eth_call 通常不由用户支付 gas，但 pure 被其他合约在交易中调用时仍占用执行资源。", keyPoint: "费用取决于调用上下文，不只取决于修饰符。", tags: ["pure", "gas", "误区"] },
  },
  {
    slug: "data-locations", title: "06 数据位置：storage、memory、calldata", summary: "在数组基础上理解引用类型的存储位置，再进入循环和结构体。", minutes: 28,
    stageId: 1, stageTitle: "阶段二：组织数据", newConcepts: ["storage", "memory", "calldata", "引用类型复制"], prerequisiteConcepts: ["数组", "view", "pure", "return", "string"],
    objectives: ["能解释 storage、memory、calldata 的生命周期", "能判断参数是否应使用 calldata", "能识别 storage 引用导致的原地修改"], practiceFocus: "只使用 uint 数组作为例子，暂不引入 mapping 和权限。", projectMilestone: "为 Registry 添加临时排序和只读数组摘要能力。", sourceUrl: `${source}types.html#data-location`, sourceLocator: "Data location",
    concept: { question: "storage、memory 和 calldata 的核心差异是什么？", answer: "storage 是持久链上状态；memory 是一次调用期间可修改的临时内存；calldata 是外部输入的只读区域。选择位置会影响生命周期、可修改性和 gas。", keyPoint: "引用类型必须同时回答‘放在哪里’和‘能否修改’。", tags: ["storage", "memory", "calldata"] },
    check: { question: "为什么外部函数的数组参数通常使用 calldata？", answer: "calldata 直接引用调用输入且只读，避免不必要的复制；若需要修改，才复制到 memory。", keyPoint: "只读输入优先使用 calldata 表达意图。", tags: ["calldata", "数组", "gas"] },
    code: [
      { type: "code_read", question: "判断 mutate 与 inspect 是否会改变状态数组。", answer: "mutate 使用 storage 引用，修改 temp[0] 会直接改写 storage；inspect 使用 calldata，只读取输入，不影响状态。", keyPoint: "storage 引用不是副本，修改会落到链上状态。", starterCode: "uint256[] public values;\nfunction mutate() external { uint256[] storage temp = values; temp.push(7); }\nfunction inspect(uint256[] calldata input) external pure returns (uint256) { return input[0]; }", solutionCode: "mutate -> 改变 values；inspect -> 只读 calldata，不改变状态。", testInput: "调用 mutate，再 inspect([9])。", expectedResult: "values 长度增加；inspect 返回 9。", hints: ["看到 storage 就问是否是原地引用。", "calldata 只读。"] },
      { type: "code_complete", question: "补全 copyFirst，把 calldata 数组复制到 memory 后返回首元素。", answer: "声明 uint256[] memory local = input，再 return local[0]；这里复制后仍只读。", keyPoint: "显式复制能把外部输入带入可修改的 memory 生命周期。", starterCode: "function copyFirst(uint256[] calldata input) external pure returns (uint256) {\n    // TODO\n}", solutionCode: "function copyFirst(uint256[] calldata input) external pure returns (uint256) {\n    uint256[] memory local = input;\n    return local[0];\n}", testInput: "copyFirst([4, 8])。", expectedResult: "返回 4。", hints: ["calldata 可以复制到 memory。", "访问 local[0]。"] },
      { type: "code_write", question: "写一个 MemorySort 的 firstGreater，使用 calldata 输入和纯函数返回第一个大于 threshold 的值。", answer: "遍历 calldata 数组，找到 values[i] > threshold 后 return；没有找到时返回 0。", keyPoint: "先练习只读遍历，下一章再单独学习循环边界和数组修改。", starterCode: "// 写出 firstGreater(uint256[] calldata values, uint256 threshold)\n", solutionCode: "pragma solidity ^0.8.20;\ncontract MemorySort {\n    function firstGreater(uint256[] calldata values, uint256 threshold) external pure returns (uint256) {\n        for (uint256 i = 0; i < values.length; i++) {\n            if (values[i] > threshold) return values[i];\n        }\n        return 0;\n    }\n}", testInput: "firstGreater([2, 5, 9], 4)。", expectedResult: "返回 5。", hints: ["参数使用 calldata。", "找到后立即 return。"] },
    ],
    application: { question: "为什么数据位置是 Solidity 初学者最容易混淆的主题之一？", answer: "同一个数组类型在 storage、memory、calldata 中有不同生命周期和副作用；把其他语言的‘变量就是副本’直觉直接搬过来会产生状态漏洞。", keyPoint: "先通过小数组实验观察副作用，再进入复杂结构。", tags: ["数据位置", "副作用", "应用"] },
    misconception: { question: "误区：memory 数组的修改会永久写入链上，为什么不对？", answer: "memory 只在当前调用执行期间存在，函数结束后消失；只有把结果写回 storage 才会持久化。", keyPoint: "临时计算和持久状态必须明确分开。", tags: ["memory", "storage", "误区"] },
  },
  {
    slug: "control-flow", title: "07 控制流：用 if 和循环表达规则", summary: "在数组基础上学习条件、for、while、break 和边界。", minutes: 28,
    stageId: 1, stageTitle: "阶段二：组织数据", newConcepts: ["if/else", "for", "while", "break/continue", "循环不变量"], prerequisiteConcepts: ["数组", "函数", "pure", "uint"],
    objectives: ["能写有终止条件的 if、for 和 while", "能避免 uint 索引下溢和数组越界", "能用循环不变量解释计数结果"], practiceFocus: "所有循环都只遍历调用者输入，暂不写 storage 集合。", projectMilestone: "为 Registry 增加纯函数统计器，为后续卡片集合打基础。", sourceUrl: `${source}control-structures.html`, sourceLocator: "Control Structures",
    concept: { question: "一个安全循环必须先明确哪三个问题？", answer: "初始值、终止条件和每轮推进方式；还要确认输入规模有界，否则交易可能因 gas 用尽而失败。", keyPoint: "循环正确既包括结果，也包括可终止和边界安全。", tags: ["控制流", "循环", "gas"] },
    check: { question: "为什么 uint256 不能使用 j >= 0 作为向左遍历条件？", answer: "uint 没有负数，j 从 0 减 1 会下溢并在 Solidity 0.8 回滚；应使用 j > 0 后再访问 j - 1。", keyPoint: "移植数组算法时必须重新检查无符号索引。", tags: ["uint", "下溢", "边界"] },
    code: [
      { type: "code_read", question: "修复 sumTo 的循环边界，并推断 sumTo(4) 的结果。", answer: "i 从 1 开始，条件 i <= n，每轮 total += i；sumTo(4) 返回 10。", keyPoint: "先从数值循环理解初始化、条件和推进，再遍历数组。", starterCode: "function sumTo(uint256 n) external pure returns (uint256 total) {\n    for (uint256 i = 1; i < n; i++) {\n        total += i;\n    }\n}", solutionCode: "function sumTo(uint256 n) external pure returns (uint256 total) {\n    for (uint256 i = 1; i <= n; i++) {\n        total += i;\n    }\n}", testInput: "sumTo(4)。", expectedResult: "返回 10。", hints: ["要包含 n 本身。", "循环条件使用 <=。"] },
      { type: "code_complete", question: "补全 findFirst，找到等于 target 的数字后停止并返回索引。", answer: "循环 i 从 0 到 length-1，匹配时 return i，结束后返回 values.length。", keyPoint: "数组索引依赖上一章的 length 和边界知识。", starterCode: "function findFirst(uint256[] calldata values, uint256 target) external pure returns (uint256) {\n    for (uint256 i = 0; i < values.length; i++) {\n        // TODO\n    }\n    // TODO\n}", solutionCode: "function findFirst(uint256[] calldata values, uint256 target) external pure returns (uint256) {\n    for (uint256 i = 0; i < values.length; i++) {\n        if (values[i] == target) return i;\n    }\n    return values.length;\n}", testInput: "findFirst([4, 7, 9], 7) 和 findFirst([4, 7, 9], 8)。", expectedResult: "分别返回 1 和 3。", hints: ["最后合法索引小于 length。", "未找到返回 length。"] },
      { type: "code_write", question: "写一个 ControlLab 的 sumUntil，遍历数组，达到 limit 后停止并返回总和。", answer: "使用 for 遍历 values，sum += values[i]；当 sum >= limit 时 break，返回 sum。", keyPoint: "把数组边界和业务终止条件同时写进循环。", starterCode: "// 完成 sumUntil(uint256[] calldata values, uint256 limit)\n", solutionCode: "pragma solidity ^0.8.20;\ncontract ControlLab {\n    function sumUntil(uint256[] calldata values, uint256 limit) external pure returns (uint256 sum) {\n        for (uint256 i = 0; i < values.length; i++) {\n            sum += values[i];\n            if (sum >= limit) break;\n        }\n    }\n}", testInput: "sumUntil([2, 5, 8], 6)。", expectedResult: "返回 7，只扫描到第二项。", hints: ["每轮先累加。", "达到 limit 后 break。"] },
    ],
    application: { question: "为什么链上排序和无界遍历通常应该放到链下？", answer: "循环每轮消耗执行资源，用户可控的超大数组会让交易不可用；链下排序、分页或聚合更适合生产场景。", keyPoint: "算法复杂度会直接变成 gas 和可用性约束。", tags: ["复杂度", "gas", "应用"] },
    misconception: { question: "误区：循环只要逻辑正确就一定能执行完成，为什么不对？", answer: "即使结果逻辑正确，迭代次数过多也可能超过 gas limit；终止性和规模上限必须一起设计。", keyPoint: "可证明终止不等于可负担执行。", tags: ["循环", "gas", "误区"] },
  },
  {
    slug: "arrays", title: "05 数组：保存有序的学习记录", summary: "先用 fixed/dynamic array 和 push/length 建立集合直觉。", minutes: 26,
    stageId: 1, stageTitle: "阶段二：组织数据", newConcepts: ["fixed array", "dynamic array", "push", "length", "索引边界"], prerequisiteConcepts: ["函数写入", "uint/int", "view", "return"],
    objectives: ["能选择固定数组或动态数组", "能安全 push 和读取数组元素", "能为数组读取设计越界失败路径"], practiceFocus: "LearningRegistry 增加 chapterIds 动态数组，不使用 struct 或 mapping。", projectMilestone: "Registry 可以登记章节 ID，并按顺序读取。", sourceUrl: `${source}types.html#arrays`, sourceLocator: "Arrays",
    concept: { question: "fixed array 和 dynamic array 的使用场景有什么不同？", answer: "fixed array 的长度在类型中固定，适合明确容量；dynamic array 的长度由运行时 push 和 pop 改变，适合章节数量不预先固定的记录。", keyPoint: "集合类型要表达容量和生命周期，而不是默认使用 dynamic。", tags: ["数组", "fixed", "dynamic"] },
    check: { question: "为什么数组读取函数必须先检查 index < length？", answer: "最后合法索引是 length - 1，越界访问会回滚；显式检查还能返回更清楚的失败原因。", keyPoint: "边界检查应该靠近外部输入。", tags: ["数组", "边界", "回滚"] },
    code: [
      { type: "code_read", question: "推断 addChapter 调用后的数组长度和元素。", answer: "每次 push 把一个 ID 放到末尾，length 依次增加；读取 chapterIds[index] 按零开始的索引返回。", keyPoint: "动态数组的 length 是当前元素个数，不是最后索引。", starterCode: "uint256[] public chapterIds;\nfunction addChapter(uint256 id) external { chapterIds.push(id); }\nfunction chapterCount() external view returns (uint256) { return chapterIds.length; }", solutionCode: "addChapter(4), addChapter(9) 后：length=2，chapterIds[0]=4，chapterIds[1]=9。", testInput: "连续添加 4 和 9。", expectedResult: "计数 2，按索引读取 4、9。", hints: ["length 从 0 开始。", "索引从 0 开始。"] },
      { type: "code_complete", question: "补全 chapterAt，拒绝越界后返回 chapterIds[index]。", answer: "require(index < chapterIds.length)，再 return chapterIds[index]。", keyPoint: "先检查，再索引；不要依赖低层回滚给用户解释。", starterCode: "uint256[] public chapterIds;\nfunction chapterAt(uint256 index) external view returns (uint256) {\n    // TODO\n}", solutionCode: "uint256[] public chapterIds;\nfunction chapterAt(uint256 index) external view returns (uint256) {\n    require(index < chapterIds.length, \"index out of bounds\");\n    return chapterIds[index];\n}", testInput: "数组为 [4, 9] 时读取 1 和 2。", expectedResult: "读取 1 返回 9，读取 2 回滚。", hints: ["先比较 index 和 length。", "合法索引小于 length。"] },
      { type: "code_write", question: "写一个 ChapterList，提供 add、count 和 removeLast，removeLast 不能在空数组执行。", answer: "使用 uint256[] storage；add push，count 返回 length，removeLast require length > 0 后 pop。", keyPoint: "集合的增删接口要一起定义空集合行为。", starterCode: "// 完成 ChapterList 的 add、count、removeLast\n", solutionCode: "pragma solidity ^0.8.20;\ncontract ChapterList {\n    uint256[] public chapterIds;\n    function add(uint256 id) external { chapterIds.push(id); }\n    function count() external view returns (uint256) { return chapterIds.length; }\n    function removeLast() external { require(chapterIds.length > 0, \"empty\"); chapterIds.pop(); }\n}", testInput: "空数组 removeLast；添加 1、2 后 removeLast。", expectedResult: "空数组回滚；之后长度从 2 变为 1。", hints: ["pop 只能移除末尾。", "空数组先检查 length。"] },
    ],
    application: { question: "为什么链上数组不适合充当任意长度的全文数据库？", answer: "遍历和存储都会产生成本，删除和分页也需要额外设计；链上数组更适合小规模、顺序明确且合约确实需要读取的集合。", keyPoint: "先设计查询和规模，再选择存储结构。", tags: ["数组", "存储", "应用"] },
    misconception: { question: "误区：数组 length 就是最后一个元素的索引，为什么错？", answer: "length 是元素数量，最后索引是 length - 1；空数组没有合法索引。", keyPoint: "数量和位置必须分开。", tags: ["length", "索引", "误区"] },
  },
  {
    slug: "structs", title: "08 结构体：把一章变成可读记录", summary: "使用 struct 和 struct array 表达一条完整学习记录。", minutes: 28,
    stageId: 1, stageTitle: "阶段二：组织数据", newConcepts: ["struct", "struct 初始化", "storage struct 引用", "结构体数组"], prerequisiteConcepts: ["fixed array", "dynamic array", "storage", "函数写入"],
    objectives: ["能定义包含多个字段的 struct", "能创建、读取和修改 struct", "能避免 storage 引用的意外原地修改"], practiceFocus: "LearningRegistry 的每个 chapter 使用一个 struct，暂不按地址分组。", projectMilestone: "Registry 从只存 ID 升级为保存 id、title、active 的完整章节记录。", sourceUrl: `${source}types.html#structs`, sourceLocator: "Structs",
    concept: { question: "什么时候应该用 struct 而不是多个平行数组？", answer: "当多个字段共同描述一个实体且需要一起创建、读取或修改时，struct 能把不变量放在同一条记录中，避免索引错位。", keyPoint: "结构体让领域对象的边界直接出现在类型里。", tags: ["struct", "数据建模", "数组"] },
    check: { question: "memory struct 和 storage struct 修改时最大的区别是什么？", answer: "memory struct 是当前调用的副本；storage struct 是持久记录，引用它并修改字段会直接改变链上状态。", keyPoint: "复制和引用的区别会影响每个字段是否真正保存。", tags: ["struct", "storage", "memory"] },
    code: [
      { type: "code_read", question: "阅读 addChapter，说明新记录的字段值和数组长度。", answer: "push 创建一个新的 Chapter 记录，id、title、active 按参数写入，chapters.length 增加 1。", keyPoint: "struct push 可以把创建和集合追加放在一个明确动作里。", starterCode: "struct Chapter { uint256 id; string title; bool active; }\nChapter[] public chapters;\nfunction addChapter(uint256 id, string calldata title) external { chapters.push(Chapter(id, title, true)); }", solutionCode: "调用 addChapter(1, \"Types\") 后，chapters[0] = { id:1, title:\"Types\", active:true }。", testInput: "添加一个 Types 章节。", expectedResult: "长度为 1，字段按参数和 true 保存。", hints: ["按 struct 字段顺序初始化。", "push 会增加数组长度。"] },
      { type: "code_complete", question: "补全 deactivate，让指定章节的 active 变为 false。", answer: "先检查 index < chapters.length，再执行 chapters[index].active = false。", keyPoint: "直接修改 storage struct 字段前要保护索引边界。", starterCode: "struct Chapter { uint256 id; string title; bool active; }\nChapter[] public chapters;\nfunction deactivate(uint256 index) external {\n    // TODO\n}", solutionCode: "function deactivate(uint256 index) external {\n    require(index < chapters.length, \"missing chapter\");\n    chapters[index].active = false;\n}", testInput: "deactivate(0) 和 deactivate(1)。", expectedResult: "存在的章节变 false，越界回滚。", hints: ["章节是 storage 数组。", "修改 active 字段。"] },
      { type: "code_write", question: "写一个 ChapterRegistry，支持 addChapter、chapterTitle 和 archive。", answer: "定义 Chapter struct 和动态数组；add 创建 active=true 的记录；读取函数返回 title；archive 把 active 改为 false。", keyPoint: "一个实体的创建、读取和状态变化应围绕同一个 struct。", starterCode: "// 完成 ChapterRegistry，记录章节 id/title/active\n", solutionCode: "pragma solidity ^0.8.20;\ncontract ChapterRegistry {\n    struct Chapter { uint256 id; string title; bool active; }\n    Chapter[] public chapters;\n    function addChapter(string calldata title) external { chapters.push(Chapter(chapters.length, title, true)); }\n    function chapterTitle(uint256 index) external view returns (string memory) { require(index < chapters.length); return chapters[index].title; }\n    function archive(uint256 index) external { require(index < chapters.length); chapters[index].active = false; }\n}", testInput: "添加 Types，读取标题，再 archive。", expectedResult: "标题为 Types，archive 后 active=false。", hints: ["id 可以使用当前 length。", "storage struct 字段可直接写。"] },
    ],
    application: { question: "为什么 struct 比多个数组更适合 LearningRegistry？", answer: "章节的 id、标题和 active 是一个业务对象，struct 能避免 chaptersIds、titles、flags 三个数组出现长度或索引错位。", keyPoint: "数据模型应该保护实体的完整性。", tags: ["struct", "一致性", "应用"] },
    misconception: { question: "误区：struct 中的 string 只要标记 private 就不会占用 storage，为什么错？", answer: "private 不改变数据存储；string 仍会占用 storage，且链上数据并非私密。", keyPoint: "存储成本和可见性是独立问题。", tags: ["struct", "storage", "误区"] },
  },
  {
    slug: "mapping", title: "09 Mapping：按地址索引学习进度", summary: "在已有 struct 和数组之后，引入 mapping 的键值访问和存在性标记。", minutes: 30,
    stageId: 2, stageTitle: "阶段三：按用户建模", newConcepts: ["mapping", "address key", "mapping 默认值", "exists 标记", "delete 重置"], prerequisiteConcepts: ["struct", "address", "数组", "函数写入"],
    objectives: ["能定义 mapping(address => T)", "能按 msg.sender 读写个人记录", "能解释 mapping 无法枚举 key 和默认值歧义"], practiceFocus: "只按用户地址保存完成章节数，不提前加入 owner 或权限。", projectMilestone: "Registry 能为每个学习者记录 completedCount。", sourceUrl: `${source}types.html#mapping-types`, sourceLocator: "Mapping Types",
    concept: { question: "mapping 和数组的访问模型有什么不同，delete 又解决什么问题？", answer: "mapping 通过 key 直接定位 value，适合地址到账户记录；它不保存可遍历的 key 列表。delete 可以把某个 key 的 value 重置为零值，但不会删除或提供 key 列表。", keyPoint: "快速按 key 读取不等于可查询全集，delete 也不等于删除对象。", tags: ["mapping", "address", "索引", "delete"] },
    check: { question: "为什么 mapping 的零值会造成‘未登记’和‘登记为 0’的歧义，什么时候用 delete？", answer: "不存在 key 和主动 delete 都会返回 value 默认值；如果需要区分生命周期要增加 exists 字段。delete 适合用户清除自己的记录或重置数组。", keyPoint: "默认值不是存在性证明，重置要有明确业务语义。", tags: ["默认值", "exists", "mapping", "delete"] },
    code: [
      { type: "code_read", question: "阅读 progress，说明新地址读取、mark 和 resetSelf 的效果。", answer: "新地址是 (0,false)；mark 把 count 写入并设置 exists=true；delete 后 count 回到 0，但 exists 也要显式重置，否则会留下生命周期歧义。", keyPoint: "mapping 默认值和 delete 都需要配合存在性字段。", starterCode: "mapping(address => uint256) public completedCount;\nmapping(address => bool) public hasProgress;\nfunction mark(uint256 count) external { completedCount[msg.sender] = count; hasProgress[msg.sender] = true; }\nfunction resetSelf() external { delete completedCount[msg.sender]; delete hasProgress[msg.sender]; }", solutionCode: "新地址 -> (0,false)；mark(3) -> (3,true)；resetSelf -> (0,false)。", testInput: "A 读取、mark(3)、resetSelf、再次读取。", expectedResult: "状态依次为 (0,false)、(3,true)、(0,false)。", hints: ["delete 两个 mapping 元素。", "exists 也要恢复 false。"] },
      { type: "code_complete", question: "补全 complete 和 resetSelf，按 msg.sender 更新并清除自己的记录。", answer: "complete 增加 completedCount 并标记存在；resetSelf 用 delete 清除两个 mapping 元素。", keyPoint: "用户 key 来自调用上下文，清除范围也必须绑定调用者。", starterCode: "mapping(address => uint256) public completedCount;\nmapping(address => bool) public hasProgress;\nfunction complete() external {\n    // TODO\n}\nfunction resetSelf() external {\n    // TODO\n}", solutionCode: "function complete() external {\n    completedCount[msg.sender] += 1;\n    hasProgress[msg.sender] = true;\n}\nfunction resetSelf() external {\n    delete completedCount[msg.sender];\n    delete hasProgress[msg.sender];\n}", testInput: "A 调用两次，再 resetSelf；B 调用一次。", expectedResult: "A 回到 (0,false)，B 保持 (1,true)。", hints: ["delete mapping 元素。", "不要清除其他地址。"] },
      { type: "code_write", question: "写一个 LearnerProgress，提供 complete、progressOf、hasProgress 和 resetSelf。", answer: "使用两个 mapping；complete 增加计数并标记；progressOf/hasProgress 读取；resetSelf delete 调用者自己的两个元素。", keyPoint: "mapping、存在性和 delete 组合成一个完整的个人生命周期。", starterCode: "// 完成 LearnerProgress 的个人进度接口，区分未开始和已清除\n", solutionCode: "pragma solidity ^0.8.20;\ncontract LearnerProgress {\n    mapping(address => uint256) public completed;\n    mapping(address => bool) public hasProgress;\n    function complete() external { completed[msg.sender] += 1; hasProgress[msg.sender] = true; }\n    function progressOf(address learner) external view returns (uint256) { return completed[learner]; }\n    function resetSelf() external { delete completed[msg.sender]; delete hasProgress[msg.sender]; }\n}", testInput: "A 完成两次，B 读取 A，再由 A resetSelf。", expectedResult: "A 的计数和存在标记都回到零值，B 的读取不会改变 A。", hints: ["存在标记与计数一起维护。", "delete 只影响 msg.sender。"] },
    ],
    application: { question: "为什么 mapping 适合按用户查进度，却不适合直接展示‘所有学习者排行榜’？", answer: "mapping 没有可枚举 key；排行榜需要额外数组、事件索引器或链下数据库来维护用户列表。", keyPoint: "数据结构的读取能力必须匹配产品查询。", tags: ["mapping", "查询", "应用"] },
    misconception: { question: "误区：mapping 的 key 可以被 for 循环自动遍历，为什么不对？", answer: "mapping 只提供按 key 访问，没有内置 key 列表；要遍历必须自己维护地址数组并处理删除和重复。", keyPoint: "mapping 是索引，不是集合枚举器。", tags: ["mapping", "遍历", "误区"] },
  },
  {
    slug: "initial-delete", title: "10 初始值与 delete：明确重置语义", summary: "在已有数组、struct 和 mapping 后，统一学习默认值和显式清除。", minutes: 24,
    stageId: 2, stageTitle: "阶段三：按用户建模", newConcepts: ["零值", "delete scalar", "delete struct", "delete mapping element"], prerequisiteConcepts: ["mapping", "struct", "动态数组", "enum"],
    objectives: ["能列出常见类型零值", "能使用 delete 重置不同引用类型", "能区分清零和删除 key 列表"], practiceFocus: "为 Registry 增加个人重置和章节数组清空，不引入权限。", projectMilestone: "学习者可以撤销自己的进度快照，集合重置行为可测试。", sourceUrl: `${source}types.html#the-delete-operator`, sourceLocator: "The delete Operator",
    concept: { question: "delete 对标量、struct、mapping 元素和数组分别做什么？", answer: "标量回到零值，struct 各字段回到零值，mapping 的某个 key 回到 value 零值，动态数组清空；它不会提供 mapping 的 key 枚举。", keyPoint: "delete 是重置存储值，不是通用对象销毁。", tags: ["delete", "零值", "重置"] },
    check: { question: "为什么‘从未设置’和‘主动 reset’仍可能无法只靠 mapping 值区分？", answer: "两者最终都可能得到相同零值；若产品需要区分生命周期，应额外保存 exists、updatedAt 或事件。", keyPoint: "可观察的状态转换要有显式字段或日志。", tags: ["mapping", "状态机", "事件"] },
    code: [
      { type: "code_read", question: "推断 resetAll 执行前后的所有状态。", answer: "score 变 0，profile 字段回零，scores.length 变 0，status 回到第一个 enum 成员。", keyPoint: "重置结果由目标变量的类型决定。", starterCode: "uint256 public score = 88;\nstring public name = \"Alice\";\nuint256[] public scores = [80, 90];\nenum Status { Active, Archived }\nStatus public status = Status.Archived;\nfunction resetAll() external { delete score; delete name; delete scores; delete status; }", solutionCode: "resetAll 后：score=0、name=\"\"、scores.length=0、status=Active。", testInput: "部署后调用 resetAll。", expectedResult: "所有变量回到类型零值。", hints: ["enum 回到第一项。", "动态数组 length 变 0。"] },
      { type: "code_complete", question: "补全 clearSelf，只清除调用者自己的 Profile。", answer: "执行 delete profiles[msg.sender]，不触碰其他地址的记录。", keyPoint: "delete 的 key 就是重置边界。", starterCode: "struct Profile { uint256 score; bool active; }\nmapping(address => Profile) public profiles;\nfunction clearSelf() external {\n    // TODO\n}", solutionCode: "function clearSelf() external {\n    delete profiles[msg.sender];\n}", testInput: "A、B 都有 profile，A 调用 clearSelf。", expectedResult: "A 回零，B 保持原值。", hints: ["delete 后接完整 mapping 元素。", "使用 msg.sender。"] },
      { type: "code_write", question: "写一个 ResettableRegistry，支持 addChapter、clearChapters 和 chapterCount。", answer: "动态数组 push 章节 ID；clearChapters 使用 delete；chapterCount 返回 length。", keyPoint: "显式 reset 接口让前端能观察清空后的确定状态。", starterCode: "// 完成章节数组的添加、清空和计数\n", solutionCode: "pragma solidity ^0.8.20;\ncontract ResettableRegistry {\n    uint256[] public chapterIds;\n    function addChapter(uint256 id) external { chapterIds.push(id); }\n    function clearChapters() external { delete chapterIds; }\n    function chapterCount() external view returns (uint256) { return chapterIds.length; }\n}", testInput: "添加 1、2 后 clearChapters。", expectedResult: "计数从 2 变为 0。", hints: ["delete 动态数组。", "读取 length。"] },
    ],
    application: { question: "什么时候应提供显式 reset，而不是让前端把零值猜成未初始化？", answer: "当用户可以撤销、重新开始或删除个人资料时，应提供明确的状态转换和反馈；隐藏依赖零值会让前端无法区分生命周期。", keyPoint: "状态重置应可调用、可测试、可观察。", tags: ["reset", "状态", "应用"] },
    misconception: { question: "误区：delete contract 会销毁合约，为什么错？", answer: "delete 只作用于变量并恢复其零值，和销毁合约代码是不同机制。", keyPoint: "重置 storage 不等于删除部署实例。", tags: ["delete", "销毁", "误区"] },
  },
  {
    slug: "constant", title: "11 constant：把编译期规则固定下来", summary: "先只学习 constant，immutable 留到 constructor 之后，避免概念抢跑。", minutes: 20,
    stageId: 2, stageTitle: "阶段三：按用户建模", newConcepts: ["constructor", "部署时 msg.sender", "immutable", "constant 配置"], prerequisiteConcepts: ["值类型", "函数", "address"],
    objectives: ["能判断值是否适合 constant", "能使用 constant 表达上限和版本", "能避免把运行时配置错误声明为 constant"], practiceFocus: "只固定 MAX_CHAPTERS 和 PACK_VERSION，不引入 constructor。", projectMilestone: "Registry 拥有公开、稳定且无需 storage 写入的规则常量。", sourceUrl: `${source}contracts.html#constant-and-immutable-state-variables`, sourceLocator: "Constant State Variables",
    concept: { question: "constant 的赋值时机和生命周期是什么？", answer: "constant 必须在编译期确定，编译器可将其内联；部署后不能按实例改变，适合协议上限、版本和固定选择器。", keyPoint: "编译期固定和部署期固定不是一回事。", tags: ["constant", "编译期", "配置"] },
    check: { question: "为什么每个部署实例不同的 owner 不能使用 constant？", answer: "owner 依赖部署调用者，只有部署执行时才能确定；constant 在编译期就必须确定，应该等 constructor 章节学习 immutable。", keyPoint: "先看值的确定时机，再选择变量修饰符。", tags: ["constant", "owner", "先修"] },
    code: [
      { type: "code_read", question: "阅读 RegistryRules，判断哪些值能在不同部署间变化。", answer: "MAX_CHAPTERS 和 VERSION 对所有实例相同且由编译器确定；它们不是用户配置。", keyPoint: "constant 没有运行时写入窗口。", starterCode: "contract RegistryRules {\n    uint256 public constant MAX_CHAPTERS = 18;\n    bytes4 public constant VERSION = 0x01000000;\n}", solutionCode: "MAX_CHAPTERS=18；VERSION=0x01000000；任何实例都不能修改它们。", testInput: "部署两个实例并读取常量。", expectedResult: "两个实例返回相同值。", hints: ["看 constant。", "没有 constructor 赋值。"] },
      { type: "code_complete", question: "补全 canAdd，判断 currentCount 是否没有超过 MAX_CHAPTERS。", answer: "返回 currentCount < MAX_CHAPTERS；函数只依赖参数和 constant，可以声明 pure。", keyPoint: "常量可以参与纯计算，不需要读取 storage。", starterCode: "uint256 public constant MAX_CHAPTERS = 18;\nfunction canAdd(uint256 currentCount) external /* TODO */ returns (bool) {\n    // TODO\n}", solutionCode: "uint256 public constant MAX_CHAPTERS = 18;\nfunction canAdd(uint256 currentCount) external pure returns (bool) {\n    return currentCount < MAX_CHAPTERS;\n}", testInput: "canAdd(17) 和 canAdd(18)。", expectedResult: "true、false。", hints: ["constant 不算运行时状态读取。", "上限使用 <。"] },
      { type: "code_write", question: "写一个 RegistryRules，包含 constant MAX_CARDS=126 和 isValidCardCount。", answer: "MAX_CARDS 声明为 uint256 constant；isValidCardCount 使用 pure 返回 count > 0 && count <= MAX_CARDS。", keyPoint: "把不会因实例改变的协议约束写成编译期常量。", starterCode: "// 完成 MAX_CARDS 和 isValidCardCount\n", solutionCode: "pragma solidity ^0.8.20;\ncontract RegistryRules {\n    uint256 public constant MAX_CARDS = 126;\n    function isValidCardCount(uint256 count) external pure returns (bool) {\n        return count > 0 && count <= MAX_CARDS;\n    }\n}", testInput: "验证 0、1、126、127。", expectedResult: "false、true、true、false。", hints: ["上限是 constant。", "pure 只依赖参数和常量。"] },
    ],
    application: { question: "为什么把固定规则写成 constant 能降低理解成本？", answer: "规则名称和数值在代码中同处出现，读者不用追踪初始化交易，编译器也能阻止运行时修改。", keyPoint: "固定约束应在类型层面表达。", tags: ["constant", "规则", "应用"] },
    misconception: { question: "误区：constant 是 public 就能在运行时修改，为什么错？", answer: "public 只生成读取 getter，constant 的值仍在编译期固定，没有写入入口。", keyPoint: "可读不等于可写。", tags: ["constant", "public", "误区"] },
  },
  {
    slug: "constructor", title: "10 constructor：在部署时建立身份", summary: "在值类型、函数、集合和重置之后引入 constructor、部署者 msg.sender、constant 与 immutable。", minutes: 28,
    stageId: 2, stageTitle: "阶段三：按用户建模", newConcepts: ["constructor", "部署时 msg.sender", "immutable", "部署不变量", "constant 配置"], prerequisiteConcepts: ["mapping", "msg.sender", "address", "函数写入"],
    objectives: ["能在 constructor 中保存部署者", "能区分部署时和调用时的 msg.sender", "能使用 immutable 固定实例级配置"], practiceFocus: "为 LearningRegistry 设置 owner 和 treasury，但先不抽 modifier。", projectMilestone: "每个 Registry 实例拥有自己的 owner 和 treasury。", sourceUrl: `${source}contracts.html#constructors`, sourceLocator: "Constructors",
    concept: { question: "constructor 什么时候执行，constant、immutable 又分别适合什么？", answer: "constructor 只在部署交易期间执行一次；constant 在编译期固定，immutable 可在 constructor 按实例设置。固定上限用 constant，部署者和 treasury 用 immutable。", keyPoint: "编译期固定、部署期固定和运行时可变是三种不同生命周期。", tags: ["constructor", "constant", "immutable", "部署"] },
    check: { question: "constructor 中的 msg.sender 与普通函数中的 msg.sender 有什么不同？", answer: "前者是部署者，后者是当前调用者；constant 不能保存部署者，immutable 才能在 constructor 锁定每个实例不同的 owner。", keyPoint: "先看值何时确定，再选择 constant、immutable 或普通 storage。", tags: ["msg.sender", "owner", "constant", "权限"] },
    code: [
      { type: "code_read", question: "阅读 ConfigRegistry，判断两个实例的 owner、VERSION 和 MAX_CHAPTERS 是否相同。", answer: "VERSION 和 MAX_CHAPTERS 是 constant，所有实例相同；owner 在 constructor 取部署者，因此不同部署地址可不同。", keyPoint: "constant 是编译期固定，immutable 是部署期固定。", starterCode: "contract ConfigRegistry {\n    uint256 public constant VERSION = 1;\n    uint256 public constant MAX_CHAPTERS = 16;\n    address public immutable owner;\n    constructor() { owner = msg.sender; }\n}", solutionCode: "A 部署 -> owner=A；B 部署 -> owner=B；两个实例 VERSION=1、MAX_CHAPTERS=16。", testInput: "用 A、B 分别部署。", expectedResult: "owner 分别为 A、B，两个常量相同。", hints: ["看赋值发生在编译还是 constructor。", "msg.sender 是部署者。"] },
      { type: "code_complete", question: "补全 constructor，声明 MAX_CHAPTERS constant，拒绝零地址并锁定 treasury。", answer: "MAX_CHAPTERS 在声明处固定；constructor 要求 nextTreasury != address(0)，再 treasury = nextTreasury。", keyPoint: "把编译期规则和部署期配置放在各自正确的生命周期。", starterCode: "uint256 public constant MAX_CHAPTERS = 16;\naddress public immutable treasury;\nconstructor(address nextTreasury) {\n    // TODO\n}", solutionCode: "uint256 public constant MAX_CHAPTERS = 16;\naddress public immutable treasury;\nconstructor(address nextTreasury) {\n    require(nextTreasury != address(0), \"zero treasury\");\n    treasury = nextTreasury;\n}", testInput: "用有效地址和 address(0) 部署。", expectedResult: "有效地址部署成功，零地址部署回滚，MAX_CHAPTERS 始终为 16。", hints: ["constant 不在 constructor 赋值。", "immutable 可在 constructor 写一次。"] },
      { type: "code_write", question: "写一个 OwnedRegistry，包含 constant MAX_CHAPTERS、immutable owner 和 immutable treasury。", answer: "MAX_CHAPTERS=16 在编译期固定；constructor 校验 treasury，保存 owner=msg.sender 和 treasury；提供读取函数。", keyPoint: "这是主线第一次同时固定协议规则和实例身份。", starterCode: "// 完成 MAX_CHAPTERS、owner、treasury、constructor 和读取函数\n", solutionCode: "pragma solidity ^0.8.20;\ncontract OwnedRegistry {\n    uint256 public constant MAX_CHAPTERS = 16;\n    address public immutable owner;\n    address public immutable treasury;\n    constructor(address nextTreasury) { require(nextTreasury != address(0)); owner = msg.sender; treasury = nextTreasury; }\n    function ownerAddress() external view returns (address) { return owner; }\n}", testInput: "A 用有效 treasury 部署，再读取三个配置。", expectedResult: "MAX_CHAPTERS=16，owner=A，treasury=部署参数。", hints: ["constant 不需要 constructor 赋值。", "先校验 treasury，再保存两个 immutable。"] },
    ],
    application: { question: "为什么 constructor 适合校验 treasury 等配置，而不是让前端部署后再设置？", answer: "部署后再设置会产生未初始化窗口，可能被错误调用；constructor 能让实例从第一笔可见状态开始就满足不变量。", keyPoint: "初始化窗口越短，状态越容易审计。", tags: ["初始化", "不变量", "应用"] },
    misconception: { question: "误区：immutable 就是 private，为什么错？", answer: "immutable 约束能否修改，private 只约束源码访问；immutable 地址仍可通过 getter 或链上数据观察。", keyPoint: "不可变性、可见性和隐私相互独立。", tags: ["immutable", "private", "误区"] },
  },
  {
    slug: "modifiers-access", title: "11 modifier：把 owner 规则复用起来", summary: "在身份建立后抽取 onlyOwner，并学习检查顺序和状态转换。", minutes: 28,
    stageId: 3, stageTitle: "阶段四：建立权限", newConcepts: ["modifier", "onlyOwner", "权限前置条件", "状态转换"], prerequisiteConcepts: ["constructor", "immutable", "msg.sender", "require"],
    objectives: ["能编写检查 msg.sender 的 onlyOwner", "能解释下划线的执行位置", "能把权限和业务边界检查分开"], practiceFocus: "只有 owner 能修改 Registry 的 title、active 和规则配置。", projectMilestone: "Registry 具备可复用的管理员边界。", sourceUrl: `${source}contracts.html#function-modifiers`, sourceLocator: "Function Modifiers",
    concept: { question: "modifier 为什么适合 onlyOwner，而不适合塞进所有业务规则？", answer: "modifier 适合重复的横切条件，如角色和暂停状态；金额上限、数组边界和状态机顺序仍属于具体函数。", keyPoint: "抽象重复检查，但保留业务规则的局部可读性。", tags: ["modifier", "onlyOwner", "抽象"] },
    check: { question: "onlyOwner 中 _ 放在 require 前后有什么差别？", answer: "放在检查后会先验证再执行函数主体；放在检查前会让主体先执行，可能导致未授权状态写入。", keyPoint: "_ 是函数主体插入点，位置就是安全顺序。", tags: ["modifier", "执行顺序", "安全"] },
    code: [
      { type: "code_read", question: "审查 setTitle 和 publish，哪些调用者能成功？", answer: "两个函数都有 onlyOwner，只有 owner 能执行；publish 还要求当前状态未发布。", keyPoint: "权限检查与业务状态检查可以叠加但职责不同。", starterCode: "address public immutable owner;\nbool public published;\nmodifier onlyOwner() { require(msg.sender == owner, \"not owner\"); _; }\nfunction setTitle(string calldata next) external onlyOwner { title = next; }\nfunction publish() external onlyOwner { require(!published, \"already published\"); published = true; }", solutionCode: "非 owner -> onlyOwner 回滚；owner 首次 publish 成功；owner 再次 publish 被业务检查回滚。", testInput: "A 部署，B/A 调用 setTitle 和 publish。", expectedResult: "B 均回滚；A 首次成功，重复发布回滚。", hints: ["先看 modifier。", "再看函数内部的 published 检查。"] },
      { type: "code_complete", question: "补全 onlyOwner，并把 setTitle 标记为 onlyOwner。", answer: "modifier require(msg.sender == owner); _;，函数签名写 external onlyOwner。", keyPoint: "所有敏感写入口都要逐个检查是否带权限。", starterCode: "address public immutable owner;\nmodifier onlyOwner() {\n    // TODO\n}\nfunction setTitle(string calldata next) external /* TODO */ { title = next; }", solutionCode: "modifier onlyOwner() {\n    require(msg.sender == owner, \"not owner\");\n    _;\n}\nfunction setTitle(string calldata next) external onlyOwner { title = next; }", testInput: "owner 和普通地址调用 setTitle。", expectedResult: "只有 owner 成功。", hints: ["下划线保留函数主体。", "modifier 写在可见性之后。"] },
      { type: "code_write", question: "写一个 AccessRegistry，只有 owner 能 pause/unpause 和 setTitle。", answer: "constructor 设置 owner，onlyOwner 检查调用者，三个状态函数分别更新 paused 和 title。", keyPoint: "权限是每条敏感状态转换的入口条件。", starterCode: "// 完成 owner、onlyOwner、paused、pause、unpause、setTitle\n", solutionCode: "pragma solidity ^0.8.20;\ncontract AccessRegistry {\n    address public immutable owner;\n    bool public paused;\n    string public title;\n    constructor() { owner = msg.sender; }\n    modifier onlyOwner() { require(msg.sender == owner, \"not owner\"); _; }\n    function pause() external onlyOwner { paused = true; }\n    function unpause() external onlyOwner { paused = false; }\n    function setTitle(string calldata next) external onlyOwner { title = next; }\n}", testInput: "B 调用 pause，A 调用 pause、setTitle、unpause。", expectedResult: "B 回滚；A 可完成全部转换。", hints: ["owner 来自 constructor。", "三个写函数都带 onlyOwner。"] },
    ],
    application: { question: "为什么权限检查通常应该在状态写入之前？", answer: "先验证能让未授权调用在任何副作用前回滚，减少审计时对部分执行路径的推理。", keyPoint: "检查、效果和外部交互的顺序会在后续安全章节再次出现。", tags: ["权限", "检查", "顺序"] },
    misconception: { question: "误区：只要 owner 是 immutable，函数就自动受保护，为什么错？", answer: "immutable 只保存一个不可变地址；每个敏感函数仍必须明确比较 msg.sender 或使用 modifier。", keyPoint: "保存身份不等于执行授权。", tags: ["immutable", "授权", "误区"] },
  },
  {
    slug: "events", title: "12 events：让权限操作可被追踪", summary: "在状态和权限稳定后引入 event、emit、indexed 和日志查询。", minutes: 26,
    stageId: 3, stageTitle: "阶段四：建立权限", newConcepts: ["event", "emit", "indexed", "topics/data"], prerequisiteConcepts: ["modifier", "onlyOwner", "状态转换", "address"],
    objectives: ["能为关键状态变化设计事件", "能选择 indexed 参数进行筛选", "能区分事件历史和当前 storage 状态"], practiceFocus: "Registry 的创建章节、发布和暂停都要发出可查询事件。", projectMilestone: "前端可以通过日志重建 Registry 的关键动作历史。", sourceUrl: `${source}contracts.html#events`, sourceLocator: "Events",
    concept: { question: "event 和 storage 各自应该保存什么？", answer: "storage 保存合约后续执行需要的当前状态；event 记录发生过的事实，供前端和索引器查询。合约本身不能读取自己的 event。", keyPoint: "当前值和历史事实不能互相替代。", tags: ["event", "storage", "日志"] },
    check: { question: "indexed 参数在 topics 中有什么作用？", answer: "非匿名事件最多三个 indexed 参数进入 topics，可被前端按地址或 ID 筛选；普通参数编码在 data 中。", keyPoint: "indexed 是查询索引，不是加密。", tags: ["indexed", "topics", "查询"] },
    code: [
      { type: "code_read", question: "阅读 ChapterAdded 日志，指出 topics 和 data 中的字段。", answer: "topics[0] 是事件签名，topics[1] 是 indexed chapterId；title 在 data 中。", keyPoint: "事件日志布局由 indexed 标记决定。", starterCode: "event ChapterAdded(uint256 indexed chapterId, string title);\nfunction add(uint256 id, string calldata title) external { emit ChapterAdded(id, title); }", solutionCode: "topics -> 事件签名和 chapterId；data -> title。", testInput: "调用 add(3, \"Mapping\")。", expectedResult: "产生可按 chapterId=3 筛选的日志。", hints: ["第一个 topic 是签名。", "只有 indexed 参数进入 topics。"] },
      { type: "code_complete", question: "补全 setPaused，让成功的状态变化发出 Paused 事件。", answer: "声明 event Paused(address indexed actor, bool value)，写入 paused 后 emit。", keyPoint: "事件应描述已经成功提交的状态变化。", starterCode: "event Paused(address indexed actor, bool value);\nbool public paused;\nfunction setPaused(bool next) external onlyOwner {\n    // TODO\n}", solutionCode: "function setPaused(bool next) external onlyOwner {\n    paused = next;\n    emit Paused(msg.sender, next);\n}", testInput: "owner setPaused(true)。", expectedResult: "paused=true，并产生 actor=owner、value=true 的日志。", hints: ["先写状态，再 emit。", "msg.sender 适合 indexed actor。"] },
      { type: "code_write", question: "写一个 EventRegistry：owner 添加章节时保存记录并发出 ChapterAdded。", answer: "定义 owner、Chapter struct、onlyOwner 和 event；addChapter 检查权限，push 记录，再 emit。", keyPoint: "日志把权限动作与业务实体 ID 连接起来。", starterCode: "// 完成 EventRegistry 的 addChapter 和 ChapterAdded 事件\n", solutionCode: "pragma solidity ^0.8.20;\ncontract EventRegistry {\n    address public immutable owner;\n    struct Chapter { uint256 id; string title; }\n    Chapter[] public chapters;\n    event ChapterAdded(uint256 indexed chapterId, string title, address indexed actor);\n    constructor() { owner = msg.sender; }\n    function addChapter(string calldata title) external {\n        require(msg.sender == owner, \"not owner\");\n        uint256 id = chapters.length;\n        chapters.push(Chapter(id, title));\n        emit ChapterAdded(id, title, msg.sender);\n    }\n}", testInput: "A 添加 Types，B 尝试添加 Mapping。", expectedResult: "A 成功并发日志，B 回滚且没有日志。", hints: ["日志只出现在成功交易。", "章节 ID 使用 push 前的 length。"] },
    ],
    application: { question: "为什么前端不能只监听事件而不读取 storage？", answer: "事件是历史记录，可能有索引延迟或重组；当前 title、paused 等业务真相仍应从 storage 读取。", keyPoint: "事件加速查询，storage 保持当前状态权威。", tags: ["前端", "事件", "状态"] },
    misconception: { question: "误区：emit 在函数中执行过就永远存在，为什么不对？", answer: "如果交易后续回滚，整笔交易的状态和日志都会回滚；日志与成功收据原子绑定。", keyPoint: "先保证成功路径，再依赖事件提供历史。", tags: ["回滚", "日志", "误区"] },
  },
  {
    slug: "payable-value", title: "13 payable：让 Registry 接收学习押金", summary: "在权限和事件之后加入 msg.value、payable、余额和安全转账。", minutes: 32,
    stageId: 3, stageTitle: "阶段四：建立权限", newConcepts: ["payable", "msg.value", "address(this).balance", "call value", "checks-effects-interactions"], prerequisiteConcepts: ["constructor", "modifier", "events", "require"],
    objectives: ["能接收并记录 msg.value", "能按 checks-effects-interactions 组织提取", "能检查低级 call 的 bool 结果"], practiceFocus: "实现 owner 提取学习押金，所有金额和转账失败路径可回滚。", projectMilestone: "Registry 支持 deposit 和 owner withdraw，并有事件审计。", sourceUrl: `${source}contracts.html#receive-ether-function`, sourceLocator: "receive Ether / payable",
    concept: { question: "payable 允许什么，不能替你完成什么？", answer: "payable 允许函数接收 Ether，msg.value 读取本次携带金额；它不会自动记账、验证金额或安全转账。", keyPoint: "价值转移的每一步都必须显式设计。", tags: ["payable", "msg.value", "Ether"] },
    check: { question: "提取 Ether 时为什么先减少内部余额再进行 call？", answer: "先更新内部状态再外部交互能遵循 checks-effects-interactions，减少重入时重复提取的窗口；call 失败会让整个交易回滚。", keyPoint: "外部调用是信任边界，状态顺序是安全边界。", tags: ["CEI", "call", "重入"] },
    code: [
      { type: "code_read", question: "审查 DepositVault 的存款和提取路径。", answer: "deposit 检查 msg.value>0 后增加 deposits 和 total；withdraw 先检查 owner/余额，减少 total，再 call，最后检查 ok。", keyPoint: "本地记账和实际余额必须在同一成功路径。", starterCode: "mapping(address => uint256) public deposits;\nuint256 public total;\nfunction deposit() external payable { require(msg.value > 0); deposits[msg.sender] += msg.value; total += msg.value; }\nfunction withdraw(uint256 amount) external onlyOwner { require(amount <= total); total -= amount; (bool ok,) = payable(owner).call{value: amount}(\"\"); require(ok); }", solutionCode: "成功 deposit -> 用户和 total 增加；成功 withdraw -> total 减少且 owner 收到 Ether；任何 require/call 失败都回滚。", testInput: "A 存 2 ether，B 尝试提取，A 提取 1 ether。", expectedResult: "B 回滚，A 成功，total=1 ether。", hints: ["看 onlyOwner。", "外部 call 后检查 ok。"] },
      { type: "code_complete", question: "补全 deposit，拒绝零金额、累计 deposits 并发出 Deposited。", answer: "函数标记 payable，require(msg.value > 0)，增加 deposits[msg.sender]，emit Deposited。", keyPoint: "payable、记账和事件是三个独立动作。", starterCode: "mapping(address => uint256) public deposits;\nevent Deposited(address indexed user, uint256 amount);\nfunction deposit() external payable {\n    // TODO\n}", solutionCode: "function deposit() external payable {\n    require(msg.value > 0, \"zero deposit\");\n    deposits[msg.sender] += msg.value;\n    emit Deposited(msg.sender, msg.value);\n}", testInput: "A 携带 0 和 2 ether 调用。", expectedResult: "0 回滚；2 ether 记账并发事件。", hints: ["msg.value 是本次金额。", "事件放在成功写入后。"] },
      { type: "code_write", question: "写一个 LearningVault：用户 deposit，owner withdraw，使用 CEI 和 Withdrawn 事件。", answer: "constructor 保存 owner；deposit 记录用户金额；withdraw 先权限和余额检查，再减少 total，call 转账并检查 ok，最后发事件。", keyPoint: "这是第一个把状态、权限、事件和 Ether 组合起来的里程碑。", starterCode: "// 完成 LearningVault：deposit()、withdraw()、owner、事件\n", solutionCode: "pragma solidity ^0.8.20;\ncontract LearningVault {\n    address public immutable owner;\n    mapping(address => uint256) public deposits;\n    uint256 public total;\n    event Deposited(address indexed user, uint256 amount);\n    event Withdrawn(address indexed to, uint256 amount);\n    constructor() { owner = msg.sender; }\n    function deposit() external payable { require(msg.value > 0); deposits[msg.sender] += msg.value; total += msg.value; emit Deposited(msg.sender, msg.value); }\n    function withdraw(uint256 amount) external { require(msg.sender == owner, \"not owner\"); require(amount <= total, \"insufficient\"); total -= amount; (bool ok,) = payable(owner).call{value: amount}(\"\"); require(ok, \"transfer failed\"); emit Withdrawn(owner, amount); }\n}", testInput: "B 存款 1 ether；B 提取；A 提取 1 ether。", expectedResult: "B 提取回滚；A 成功，total 清零且发出 Withdrawn。", hints: ["先检查再减 total。", "低级 call 的 bool 必须检查。"] },
    ],
    application: { question: "为什么 payable 章节放在 events 和 modifier 之后？", answer: "价值转移同时需要权限、可观察日志和失败路径；先掌握这些基础，才能避免把 payable 当成‘自动收款’。", keyPoint: "高风险能力应该建立在已学的边界之上。", tags: ["学习路径", "payable", "安全"] },
    misconception: { question: "误区：合约 balance 等于每个用户 deposits 的总和，为什么不一定？", answer: "合约可能收到直接转账、支付 gas 不影响余额、或存在未记账路径；内部 total 是业务记账，address(this).balance 是实际余额，两者要分别校验。", keyPoint: "业务账本和 EVM 余额不是同一个来源。", tags: ["balance", "记账", "误区"] },
  },
  {
    slug: "inheritance", title: "14 inheritance：拆出可复用的基础合约", summary: "在完整基础合约后学习 virtual、override、super 和抽象契约。", minutes: 28,
    stageId: 4, stageTitle: "阶段五：组合合约", newConcepts: ["abstract contract", "virtual", "override", "super", "继承构造"], prerequisiteConcepts: ["modifier", "events", "payable", "struct"],
    objectives: ["能编写基础合约和派生合约", "能正确使用 virtual/override/super", "能判断继承还是组合更清晰"], practiceFocus: "把 Registry 的计数逻辑拆成 BaseRegistry，派生合约增加奖励策略。", projectMilestone: "LearningRegistry 形成基础能力与扩展能力两层结构。", sourceUrl: `${source}contracts.html#inheritance`, sourceLocator: "Inheritance",
    concept: { question: "virtual、override 和 super 各自表示什么？", answer: "virtual 允许派生合约重写；override 声明当前函数履行父契约；super 显式调用父实现。父实现不会因为 override 自动执行。", keyPoint: "重写关系和复用关系都要写在代码里。", tags: ["继承", "virtual", "override"] },
    check: { question: "为什么抽象合约不能直接部署？", answer: "抽象合约包含未实现的函数契约，无法生成完整可执行行为；派生合约实现所有要求后才能部署。", keyPoint: "抽象层定义规则，具体层提供行为。", tags: ["abstract", "部署", "契约"] },
    code: [
      { type: "code_read", question: "调用 BonusRegistry.record 后 count 和 bonus 如何变化？", answer: "override 先调用 super.record 增加基础 count，再增加 bonus；两个效果都发生。", keyPoint: "是否保留父行为取决于显式 super 调用。", starterCode: "contract BaseRegistry { uint256 public count; function record() public virtual { count += 1; } }\ncontract BonusRegistry is BaseRegistry { uint256 public bonus; function record() public override { super.record(); bonus += 10; } }", solutionCode: "调用一次 -> count=1、bonus=10。", testInput: "部署 BonusRegistry，调用 record。", expectedResult: "count=1，bonus=10。", hints: ["先看 super.record。", "再看 bonus 写入。"] },
      { type: "code_complete", question: "补全 PausableRegistry 的 override，使 paused 时拒绝并复用父计数。", answer: "require(!paused)，然后 super.record()。", keyPoint: "派生合约增加前置条件，父合约保留通用效果。", starterCode: "contract BaseRegistry { uint256 public count; function record() public virtual { count += 1; } }\ncontract PausableRegistry is BaseRegistry { bool public paused; function record() public override {\n    // TODO\n} }", solutionCode: "function record() public override {\n    require(!paused, \"paused\");\n    super.record();\n}", testInput: "paused=true/false 时分别 record。", expectedResult: "暂停回滚，恢复后 count 增加 1。", hints: ["先检查 paused。", "用 super 保留父行为。"] },
      { type: "code_write", question: "写一个 BaseRegistry 和 RewardRegistry：每次 record 后按 10% 累计 bonus。", answer: "父合约维护 count，record 标记 virtual；派生合约 override，先 super.record，再 bonus += value / 10。", keyPoint: "父层保存稳定不变量，子层增加可替换策略。", starterCode: "// 完成 BaseRegistry/RewardRegistry，record(100) 得 bonus=10\n", solutionCode: "pragma solidity ^0.8.20;\ncontract BaseRegistry { uint256 public count; function record(uint256 value) public virtual { count += value; } }\ncontract RewardRegistry is BaseRegistry { uint256 public bonus; function record(uint256 value) public override { super.record(value); bonus += value / 10; } }", testInput: "record(100) 和 record(9)。", expectedResult: "count=109，bonus=10。", hints: ["父函数声明 virtual。", "整数除法向下取整。"] },
    ],
    application: { question: "什么时候组合比继承更适合？", answer: "如果只需要调用一个可替换组件，组合不会引入父状态、线性化和 override 约束，测试边界更清晰。", keyPoint: "继承表达稳定 is-a 关系，不是复用代码的唯一方式。", tags: ["组合", "架构", "应用"] },
    misconception: { question: "误区：子合约 override 后父函数还会自动执行，为什么错？", answer: "override 默认替换父实现，只有显式调用 super 才会复用父逻辑。", keyPoint: "执行路径必须从函数体中确认。", tags: ["override", "super", "误区"] },
  },
  {
    slug: "interfaces", title: "15 interfaces：只依赖外部合约的最小 ABI", summary: "最后学习跨合约边界、IERC20 风格函数和返回值检查。", minutes: 30,
    stageId: 4, stageTitle: "阶段五：组合合约", newConcepts: ["interface", "外部调用", "ABI 兼容", "返回值检查"], prerequisiteConcepts: ["继承", "函数签名", "payable", "require"],
    objectives: ["能写只含签名的 interface", "能通过接口调用外部合约", "能检查 bool 返回值和外部失败"], practiceFocus: "让 Registry 通过 IProgressToken 接口发放学习奖励，不实现完整代币。", projectMilestone: "LearningRegistry 可插入外部奖励合约，但只依赖最小 ABI。", sourceUrl: `${source}contracts.html#interfaces`, sourceLocator: "Interfaces",
    concept: { question: "interface 为什么能降低跨合约耦合？", answer: "interface 只描述调用者需要的函数签名和返回类型，不携带实现、状态变量或构造逻辑；实现可以替换，只要 ABI 兼容。", keyPoint: "跨边界只依赖最小契约。", tags: ["interface", "ABI", "耦合"] },
    check: { question: "调用外部 token.transfer 后为什么不能忽略 bool？", answer: "有些实现返回 false 而不回滚；忽略它会让本地账本把失败当成成功。", keyPoint: "外部合约返回值是输入，必须验证后使用。", tags: ["返回值", "token", "检查"] },
    code: [
      { type: "code_read", question: "阅读 RewardRouter，描述奖励转账成功路径。", answer: "Router 通过 IProgressToken 调用 mint，检查返回 bool，成功后才更新 rewardsIssued。", keyPoint: "外部效果和本地记账必须保持一致。", starterCode: "interface IProgressToken { function mint(address to, uint256 amount) external returns (bool); }\ncontract RewardRouter { mapping(address => uint256) public rewardsIssued; function reward(address token, uint256 amount) external { bool ok = IProgressToken(token).mint(msg.sender, amount); require(ok, \"mint failed\"); rewardsIssued[msg.sender] += amount; } }", solutionCode: "调用顺序 -> 接口编码调用 mint -> 检查 ok -> 成功后增加 rewardsIssued。", testInput: "token 返回 true 和 false 两种情况。", expectedResult: "true 记账，false 回滚且不增加 rewardsIssued。", hints: ["先看接口返回值。", "本地写入在外部成功之后。"] },
      { type: "code_complete", question: "补全 IProgressToken 和 reward，使零 token 地址与 false 返回都失败。", answer: "接口声明 mint 返回 bool；reward 检查 token != address(0)，调用后 require(ok)。", keyPoint: "地址边界和外部结果是两层不同检查。", starterCode: "interface IProgressToken {\n    // TODO\n}\nfunction reward(address token, uint256 amount) external {\n    // TODO\n}", solutionCode: "interface IProgressToken { function mint(address to, uint256 amount) external returns (bool); }\nfunction reward(address token, uint256 amount) external {\n    require(token != address(0), \"zero token\");\n    require(IProgressToken(token).mint(msg.sender, amount), \"mint failed\");\n}", testInput: "token=address(0)，以及 token 返回 false。", expectedResult: "两种情况都回滚。", hints: ["接口只写签名。", "require 可以直接检查 bool。"] },
      { type: "code_write", question: "写一个 RewardRouter，constructor 固定 token，owner 才能 distribute。", answer: "定义 IERC20Like.transfer，constructor 校验并保存 immutable token，distribute 检查 owner 并验证 transfer 返回 true。", keyPoint: "固定外部依赖、限制调用者、检查返回值组成完整跨合约边界。", starterCode: "// 完成 RewardRouter：immutable token、owner、distribute\n", solutionCode: "pragma solidity ^0.8.20;\ninterface IERC20Like { function transfer(address to, uint256 value) external returns (bool); }\ncontract RewardRouter { address public immutable owner; IERC20Like public immutable token; constructor(address tokenAddress) { require(tokenAddress != address(0)); owner = msg.sender; token = IERC20Like(tokenAddress); } function distribute(address to, uint256 amount) external { require(msg.sender == owner, \"not owner\"); require(token.transfer(to, amount), \"transfer failed\"); } }", testInput: "普通地址和 owner 分别 distribute，token 返回 true/false。", expectedResult: "权限或 token 失败都回滚，成功才转账。", hints: ["constructor 固定 token。", "外部返回值必须 require。"] },
    ],
    application: { question: "为什么接口应只包含当前需要的函数？", answer: "最小接口减少耦合和审计面，也不要求调用者了解远端合约的其他实现细节。", keyPoint: "跨合约依赖越小，替换和测试越容易。", tags: ["最小接口", "审计", "应用"] },
    misconception: { question: "误区：地址转成 interface 就证明它实现了接口，为什么不对？", answer: "类型转换只改变本地 ABI 视图，不验证对方代码；对方仍可能返回 false、异常数据或恶意执行。", keyPoint: "interface 是编码契约，不是信任证明。", tags: ["interface", "信任边界", "误区"] },
  },
  {
    slug: "errors", title: "16 errors：把失败路径写成合约契约", summary: "收束 require、revert、assert、custom error，并完成 MiniVault 综合审查。", minutes: 34,
    stageId: 5, stageTitle: "阶段六：综合审查", newConcepts: ["custom error", "revert", "assert", "失败路径审计", "MiniVault"], prerequisiteConcepts: ["interface", "payable", "modifier", "事件", "CEI"],
    objectives: ["能区分 require、revert、assert 的职责", "能定义带参数 custom error", "能审查权限、资产转移和状态不变量"], practiceFocus: "把前 17 章能力合并成可测试的 MiniVault 完整实现。", projectMilestone: "完成 LearningRegistry v1：权限、事件、Ether、外部接口和错误契约齐全。", sourceUrl: `${source}control-structures.html#error-handling-assert-require-revert-and-exceptions`, sourceLocator: "Error Handling",
    concept: { question: "require、revert、assert 和 custom error 应该怎么分工？", answer: "require 适合输入和前置条件；revert 适合分支中主动终止并返回 custom error；assert 只保护理论上永真的内部不变量；custom error 为失败提供稳定 selector 和参数。", keyPoint: "错误类型要区分用户失败和程序缺陷。", tags: ["require", "revert", "assert", "custom error"] },
    check: { question: "为什么 MiniVault 的失败测试必须同时检查错误和状态？", answer: "错误类型能定位失败规则，状态不变能证明回滚原子性；只检查错误文本可能漏掉先扣账后失败的资产漏洞。", keyPoint: "失败路径也是合约接口的一部分。", tags: ["测试", "回滚", "原子性"] },
    code: [
      { type: "code_read", question: "审查 MiniVault 的四条失败路径和记账顺序。", answer: "零存款、非 owner、余额不足和 call 失败都回滚；total 只有外部转账成功后才减少。", keyPoint: "资产效果和本地记账必须共处于成功路径。", starterCode: "error NotOwner(address caller);\nerror Insufficient(uint256 requested, uint256 available);\nerror TransferFailed();\n// MiniVault: constructor owner, deposit, withdraw with CEI", solutionCode: "失败 -> NotOwner/Insufficient/TransferFailed；成功 -> total 减少、Withdrawn 事件出现。", testInput: "B 存款 1 ether；B 提取；A 超额提取；A 正常提取。", expectedResult: "前两种失败不改变 total，A 正常提取成功。", hints: ["逐条列出 revert 分支。", "检查 total 更新位置。"] },
      { type: "code_complete", question: "补全 withdraw 的 custom error 检查和安全扣账。", answer: "非 owner revert NotOwner，超额 revert Insufficient，先 total -= amount，再 call 并检查 ok。", keyPoint: "错误参数和 CEI 顺序同时服务审计与前端。", starterCode: "error NotOwner(address caller);\nerror Insufficient(uint256 requested, uint256 available);\nerror TransferFailed();\nfunction withdraw(uint256 amount) external {\n    // TODO\n}", solutionCode: "function withdraw(uint256 amount) external {\n    if (msg.sender != owner) revert NotOwner(msg.sender);\n    if (amount > total) revert Insufficient(amount, total);\n    total -= amount;\n    (bool ok,) = payable(owner).call{value: amount}(\"\");\n    if (!ok) revert TransferFailed();\n}", testInput: "非 owner、超额、正常提取和接收方失败。", expectedResult: "错误类型清晰，所有失败都保持 total 不变。", hints: ["custom error 用 revert。", "外部 call 后检查 ok。"] },
      { type: "code_write", question: "独立完成 LearningRegistry v1 的审查版：owner、chapter struct、deposit、event、custom error 和 withdraw。", answer: "组合已有章节记录、onlyOwner、事件、payable、CEI、interface/错误思想；每条失败路径都要可解释。", keyPoint: "综合题不是引入新语法，而是验证前 17 章的组合顺序。", starterCode: "// 完成 LearningRegistry v1：章节登记、学习押金、owner 提取、失败路径\n", solutionCode: "pragma solidity ^0.8.20;\ncontract LearningRegistryV1 {\n    error NotOwner(address caller); error Insufficient(uint256 requested, uint256 available); error TransferFailed();\n    address public immutable owner;\n    struct Chapter { uint256 id; string title; bool active; }\n    Chapter[] public chapters; uint256 public total;\n    event ChapterAdded(uint256 indexed id, string title); event Deposited(address indexed user, uint256 amount); event Withdrawn(uint256 amount);\n    constructor() { owner = msg.sender; }\n    modifier onlyOwner() { if (msg.sender != owner) revert NotOwner(msg.sender); _; }\n    function addChapter(string calldata title) external onlyOwner { uint256 id = chapters.length; chapters.push(Chapter(id, title, true)); emit ChapterAdded(id, title); }\n    function deposit() external payable { require(msg.value > 0, \"zero deposit\"); total += msg.value; emit Deposited(msg.sender, msg.value); }\n    function withdraw(uint256 amount) external onlyOwner { if (amount > total) revert Insufficient(amount, total); total -= amount; (bool ok,) = payable(owner).call{value: amount}(\"\"); if (!ok) revert TransferFailed(); emit Withdrawn(amount); }\n}", testInput: "B 存款；B 添加章节；A 添加章节；A 超额和正常提取。", expectedResult: "权限和金额错误可解释，正常路径状态、事件和余额一致。", hints: ["按检查 -> 效果 -> 交互排序。", "综合题不需要再添加未学的抽象。"] },
    ],
    application: { question: "为什么最后一章应该是审查和综合，而不是继续堆新语法？", answer: "学习迁移发生在组合已有概念、解释失败路径和测试不变量时；再增加语法会稀释主线，无法验证真正掌握。", keyPoint: "最后用一个小而完整的系统收束，而不是用大而杂的 API 结束。", tags: ["综合", "审查", "学习迁移"] },
    misconception: { question: "误区：assert 越多越安全，为什么不对？", answer: "assert 表示内部不变量被破坏，用户输入、权限和外部调用失败应使用 require 或 custom error；滥用 assert 会混淆 bug 与正常失败。", keyPoint: "错误原语选择本身就是安全设计。", tags: ["assert", "输入校验", "误区"] },
  },
];

// Keep the global Project/Chapter contract at sixteen chapters while folding
// delete into mapping and constant into constructor for a tighter beginner path.
const removedStandaloneLessons = new Set(["initial-delete", "constant"]);
for (let index = lessons.length - 1; index >= 0; index--) {
  if (removedStandaloneLessons.has(lessons[index]!.slug)) lessons.splice(index, 1);
}
const lessonOrder = [
  "contract-shell", "value-types", "function-signatures", "read-write-mutability", "arrays",
  "data-locations", "control-flow", "structs", "mapping", "constructor", "modifiers-access",
  "events", "payable-value", "inheritance", "interfaces", "errors",
];
lessons.sort((left, right) => lessonOrder.indexOf(left.slug) - lessonOrder.indexOf(right.slug));

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const versionDir = path.join(root, "content/card-packs/solidity-foundations/v4");

function reference(lesson: Lesson) {
  return { kind: "pack_reference" as const, label: "Solidity 官方文档", url: lesson.sourceUrl, locator: lesson.sourceLocator };
}

function baseCard(lesson: Lesson, id: string, position: number, type: string, content: object) {
  return { packCardId: `v4-${lesson.slug}-${id}`, position, type, ...content, importance: type === "misconception" ? 4 : 5, initialDifficulty: type === "concept" || type === "qa" ? 2 : 3, sourceReference: reference(lesson) };
}

function codeCard(lesson: Lesson, id: string, position: number, spec: CodeSpec) {
  return baseCard(lesson, id, position, spec.type, {
    question: spec.question, answer: spec.answer, keyPoint: spec.keyPoint, tags: [lesson.slug, spec.type],
    code: { language: "solidity", starterCode: spec.starterCode, solutionCode: spec.solutionCode, testInput: spec.testInput, expectedResult: spec.expectedResult, hints: spec.hints },
  });
}

async function main() {
  await rm(versionDir, { recursive: true, force: true });
  await mkdir(path.join(versionDir, "chapters"), { recursive: true });
  const chapters = [];
  for (const [index, lesson] of lessons.entries()) {
    const prerequisiteChapterIds = index === 0 ? [] : [index - 1];
    const metadata = {
      learningObjectives: lesson.objectives, prerequisiteChapterIds, stageId: lesson.stageId, stageTitle: lesson.stageTitle,
      newConcepts: lesson.newConcepts, prerequisiteConcepts: lesson.prerequisiteConcepts, practiceFocus: lesson.practiceFocus, projectMilestone: lesson.projectMilestone,
    };
    const cards = [
      baseCard(lesson, "concept", 0, "concept", { ...lesson.concept }),
      baseCard(lesson, "check", 1, "qa", { ...lesson.check }),
      codeCard(lesson, "read", 2, lesson.code[0]),
      codeCard(lesson, "complete", 3, lesson.code[1]),
      codeCard(lesson, "write", 4, lesson.code[2]),
      baseCard(lesson, "application", 5, "application", { ...lesson.application }),
      baseCard(lesson, "misconception", 6, "misconception", { ...lesson.misconception }),
    ];
    const chapter = { chapterId: index, position: index, slug: lesson.slug, title: lesson.title, summary: lesson.summary, estimatedMinutes: lesson.minutes, ...metadata, cards };
    const filename = `${String(index + 1).padStart(2, "0")}-${lesson.slug}.json`;
    await writeFile(path.join(versionDir, "chapters", filename), `${JSON.stringify(chapter, null, 2)}\n`, "utf8");
    chapters.push({ id: index, position: index, slug: lesson.slug, title: lesson.title, summary: lesson.summary, estimatedMinutes: lesson.minutes, ...metadata, cardCount: cards.length, cardsFile: `chapters/${filename}` });
  }
  const manifest = {
    schemaVersion: 1, slug: "solidity-foundations", version: "4.0.0", title: "Solidity 101：循序渐进实战课", subject: "Solidity", language: "zh-CN", level: "beginner", license: "CC BY 4.0",
    attribution: "Mindmark Hackathon Team；课程顺序参考 WTF Academy Solidity 101，正文与代码练习由 Mindmark 重新编写",
    description: "16 个小步骤、6 个阶段、一个持续演进的 LearningRegistry，从合约外壳开始，逐层加入数据、权限、价值转移、跨合约和错误审查。每章只引入少量新概念。",
    chapters,
  };
  await writeFile(path.join(versionDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  await writeFile(path.join(versionDir, "README.md"), "# Solidity 101 循序渐进实战课 v4\n\n16 章分为 6 个阶段，每章明确新概念、先修概念、练习重点和 LearningRegistry 项目里程碑。delete 合并到 mapping，constant 合并到 constructor，避免零散章节和概念抢跑。正文与代码练习由 Mindmark 重新编写。\n", "utf8");
}

void main();
