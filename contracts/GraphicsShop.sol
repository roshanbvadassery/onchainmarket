// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

interface IAIOracle {
    function requestAIResponse(string memory prompt) external payable returns (bytes32);
    function getAIResponse(bytes32 requestId) external view returns (string memory);
    function fee() external view returns (uint256);
}

contract GraphicsShop {
    IAIOracle public immutable aiOracle;
    
    struct Bounty {
        address creator;
        string requirements;
        uint256 reward;
        bool isActive;
        address winner;
        string winningSubmission;
        mapping(address => bool) hasSubmitted;
        mapping(address => string) submissions;
    }
    
    mapping(uint256 => Bounty) public bounties;
    mapping(bytes32 => uint256) public requestToBountyId;
    mapping(bytes32 => address) public requestToSubmitter;
    uint256 public bountyCounter;
    
    event BountyCreated(uint256 indexed bountyId, address indexed creator, string requirements, uint256 reward);
    event SubmissionMade(uint256 indexed bountyId, address indexed submitter, string submissionUrl);
    event SubmissionResult(uint256 indexed bountyId, address indexed submitter, bool isAccepted, uint8 score);
    event BountyCompleted(uint256 indexed bountyId, address indexed winner, string winningSubmission, uint256 reward);
    
    constructor(address _aiOracleAddress) {
        aiOracle = IAIOracle(_aiOracleAddress);
    }
    
    function createBounty(string memory requirements) external payable {
        require(msg.value > 0, "Must provide reward");
        
        uint256 bountyId = bountyCounter++;
        Bounty storage newBounty = bounties[bountyId];
        newBounty.creator = msg.sender;
        newBounty.requirements = requirements;
        newBounty.reward = msg.value;
        newBounty.isActive = true;
        
        emit BountyCreated(bountyId, msg.sender, requirements, msg.value);
    }
    
    function submitGraphic(uint256 bountyId, string memory submissionUrl) external payable {
        Bounty storage bounty = bounties[bountyId];
        require(bounty.isActive, "Bounty is not active");
        require(!bounty.hasSubmitted[msg.sender], "Already submitted");
        require(msg.sender != bounty.creator, "Creator cannot submit");
        
        uint256 oracleFee = aiOracle.fee();
        require(msg.value >= oracleFee, "Insufficient oracle fee");
        
        bounty.hasSubmitted[msg.sender] = true;
        bounty.submissions[msg.sender] = submissionUrl;
        
        string memory prompt = string(abi.encodePacked(
            "Requirements: ", bounty.requirements, "\n",
            "Submitted graphic URL: ", submissionUrl, "\n",
            "Task: Rate how well this graphic matches the requirements.\n",
            "Scale: 0 to 10 (0 = completely incorrect, 10 = perfect match)\n",
            "Instructions: Respond with ONLY a single number between 0-10"
        ));
        
        bytes32 requestId = aiOracle.requestAIResponse{value: oracleFee}(prompt);
        requestToBountyId[requestId] = bountyId;
        requestToSubmitter[requestId] = msg.sender;
        
        emit SubmissionMade(bountyId, msg.sender, submissionUrl);
    }
    
    function handleAIResponse(bytes32 requestId, string memory prompt, string memory response) external {
        require(msg.sender == address(aiOracle), "Only AIOracle can call this");
        
        uint256 bountyId = requestToBountyId[requestId];
        address submitter = requestToSubmitter[requestId];
        Bounty storage bounty = bounties[bountyId];
        require(bounty.isActive, "Bounty not active");
        
        uint8 score = parseScore(response);
        bool isAccepted = score >= 8; // Threshold for acceptance
        
        emit SubmissionResult(bountyId, submitter, isAccepted, score);
        
        if (isAccepted) {
            bounty.isActive = false;
            bounty.winner = submitter;
            bounty.winningSubmission = bounty.submissions[submitter];
            
            payable(submitter).transfer(bounty.reward);
            
            emit BountyCompleted(bountyId, submitter, bounty.winningSubmission, bounty.reward);
        }
    }
    
    function parseScore(string memory response) internal pure returns (uint8) {
        bytes memory responseBytes = bytes(response);
        require(responseBytes.length > 0, "Empty response");
        uint8 score = uint8(responseBytes[0]) - 48; // Convert ASCII to number
        if (responseBytes.length > 1 && uint8(responseBytes[1]) == 48) {
            score = 10;
        }
        require(score <= 10, "Invalid score");
        return score;
    }
    
    function getBounty(uint256 bountyId) external view returns (
        address creator,
        string memory requirements,
        uint256 reward,
        bool isActive,
        address winner,
        string memory winningSubmission
    ) {
        Bounty storage bounty = bounties[bountyId];
        return (
            bounty.creator,
            bounty.requirements,
            bounty.reward,
            bounty.isActive,
            bounty.winner,
            bounty.winningSubmission
        );
    }
    
    function getSubmission(uint256 bountyId, address submitter) external view returns (string memory) {
        return bounties[bountyId].submissions[submitter];
    }
    
    function getOracleFee() external view returns (uint256) {
        return aiOracle.fee();
    }
} 