// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title AssetLicenseRegistry
 * @notice On-chain licensing and provenance registry for VOID·SPACE (VS-SRS-2.0 §3.9.2).
 *
 * Every approved-and-published asset receives one non-fungible ERC-721 license
 * token that anchors which exact content was approved, by whom (the platform's
 * publisher signer), under which license terms — without any dependency on a
 * public blockchain, faucet or paid RPC provider.
 *
 * Design notes
 * ------------
 * - Self-contained ERC-721: no external dependency (OpenZeppelin or otherwise),
 *   so `forge build`/`forge test` run offline and deterministically.
 * - One token per asset license. `revokeLicense` is a flag, never a burn, so the
 *   historical provenance record survives a takedown (FR-9.5).
 * - `mintLicense` keeps the exact signature documented in the SRS. The human
 *   Assessor's identity is anchored in the IPFS metadata document reachable via
 *   `tokenURI` (also recorded off-chain in the License table).
 * - `metadataCid` is set in a separate publisher-only call because the metadata
 *   document must contain the tokenId, which only exists after minting.
 */
contract AssetLicenseRegistry {
    // ------------------------------------------------------------------ ERC-721
    string public constant name = "VOID SPACE Asset License";
    string public constant symbol = "VSAL";

    address public owner;

    mapping(address => uint256) private _balances;
    mapping(uint256 => address) private _owners;
    mapping(uint256 => address) private _tokenApprovals;
    mapping(address => mapping(address => bool)) private _operatorApprovals;

    // ------------------------------------------------------------------- domain
    struct LicenseRecord {
        string assetId;
        string ipfsCid;
        string licenseTermsHash;
        string metadataCid;
        string revokedReason;
        uint64 mintedAt;
        uint64 revokedAt;
        bool revoked;
        bool metadataSet;
    }

    /// tokenId => license record. tokenIds are 1-based (tokenId 0 never exists).
    mapping(uint256 => LicenseRecord) private _licenses;

    uint256 private _nextTokenId = 1;

    /// Addresses permitted to mint/revoke/update metadata (§3.9.2 "publisher").
    mapping(address => bool) public publishers;

    // ------------------------------------------------------------------ events
    event Transfer(address indexed from, address indexed to, uint256 indexed tokenId);
    event Approval(address indexed owner, address indexed approved, uint256 indexed tokenId);
    event ApprovalForAll(address indexed owner, address indexed operator, bool approved);

    /// §3.9.2 — emitted on mint; the worker waits for this before marking 'published'.
    event LicenseMinted(
        uint256 indexed tokenId,
        string assetId,
        string ipfsCid,
        string licenseTermsHash,
        address indexed approver,
        uint64 timestamp
    );

    /// §3.9.2 — emitted on takedown; consumed to update Postgres and notify users.
    event LicenseRevoked(uint256 indexed tokenId, string reason, uint64 timestamp);

    /// Emitted once the tokenURI metadata document has been pinned to IPFS.
    event LicenseMetadataUpdated(uint256 indexed tokenId, string metadataCid);

    event PublisherUpdated(address indexed publisher, bool allowed);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    // ------------------------------------------------------------------ errors
    error NotOwner();
    error NotPublisher();
    error NotAuthorized();
    error TokenDoesNotExist(uint256 tokenId);
    error LicenseAlreadyRevoked(uint256 tokenId);
    error MetadataAlreadySet(uint256 tokenId);
    error MetadataNotSet(uint256 tokenId);
    error ZeroAddress();
    error UnsafeRecipient();
    error EmptyField(string fieldName);

    // --------------------------------------------------------------- modifiers
    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyPublisher() {
        if (msg.sender != owner && !publishers[msg.sender]) revert NotPublisher();
        _;
    }

    modifier existingToken(uint256 tokenId) {
        if (_owners[tokenId] == address(0)) revert TokenDoesNotExist(tokenId);
        _;
    }

    constructor(address initialOwner) {
        if (initialOwner == address(0)) revert ZeroAddress();
        owner = initialOwner;
        publishers[initialOwner] = true;
        emit OwnershipTransferred(address(0), initialOwner);
        emit PublisherUpdated(initialOwner, true);
    }

    // ------------------------------------------------------ publisher management
    /// @notice Grants or revokes the on-chain publisher role (§3.9.2).
    function setPublisher(address publisher, bool allowed) external onlyOwner {
        if (publisher == address(0)) revert ZeroAddress();
        publishers[publisher] = allowed;
        emit PublisherUpdated(publisher, allowed);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    // ------------------------------------------------------------------ minting
    /**
     * @notice Mints one ERC-721 license token for an approved asset.
     * @dev Called by the worker via the platform signer, only after a human
     *      Assessor has approved and confirmed publish (FR-9.2).
     * @param to Recipient of the license token (a linked user wallet, or the
     *           tenant's managed signer when the user has no wallet, §3.9.3).
     * @param assetId Off-chain asset identifier this license covers.
     * @param ipfsCid Content identifier of the licensed asset version — the
     *        tamper-evident fingerprint the license anchors to (FR-8.4, FR-9.2).
     * @param licenseTermsHash Hash of the license terms text.
     */
    function mintLicense(
        address to,
        string calldata assetId,
        string calldata ipfsCid,
        string calldata licenseTermsHash
    ) external onlyPublisher returns (uint256 tokenId) {
        if (to == address(0)) revert ZeroAddress();
        if (bytes(assetId).length == 0) revert EmptyField("assetId");
        if (bytes(ipfsCid).length == 0) revert EmptyField("ipfsCid");

        tokenId = _nextTokenId++;

        _licenses[tokenId] = LicenseRecord({
            assetId: assetId,
            ipfsCid: ipfsCid,
            licenseTermsHash: licenseTermsHash,
            metadataCid: "",
            revokedReason: "",
            mintedAt: uint64(block.timestamp),
            revokedAt: 0,
            revoked: false,
            metadataSet: false
        });

        _mint(to, tokenId);

        emit LicenseMinted(
            tokenId, assetId, ipfsCid, licenseTermsHash, msg.sender, uint64(block.timestamp)
        );
    }

    /**
     * @notice Records the IPFS CID of the token's metadata document.
     * @dev Set after minting because the document includes the tokenId.
     */
    function setLicenseMetadataCid(uint256 tokenId, string calldata metadataCid)
        external
        onlyPublisher
        existingToken(tokenId)
    {
        LicenseRecord storage record = _licenses[tokenId];
        if (record.metadataSet) revert MetadataAlreadySet(tokenId);
        if (bytes(metadataCid).length == 0) revert EmptyField("metadataCid");

        record.metadataCid = metadataCid;
        record.metadataSet = true;

        emit LicenseMetadataUpdated(tokenId, metadataCid);
    }

    /**
     * @notice Flags a license revoked (takedown) without erasing its history (FR-9.5).
     * @dev Deliberately not a burn: the provenance record must survive.
     */
    function revokeLicense(uint256 tokenId, string calldata reason)
        external
        onlyPublisher
        existingToken(tokenId)
    {
        LicenseRecord storage record = _licenses[tokenId];
        if (record.revoked) revert LicenseAlreadyRevoked(tokenId);

        record.revoked = true;
        record.revokedReason = reason;
        record.revokedAt = uint64(block.timestamp);

        emit LicenseRevoked(tokenId, reason, uint64(block.timestamp));
    }

    // ------------------------------------------------------------------- views
    function getLicense(uint256 tokenId) external view returns (LicenseRecord memory) {
        if (_owners[tokenId] == address(0)) revert TokenDoesNotExist(tokenId);
        return _licenses[tokenId];
    }

    function isLicenseValid(uint256 tokenId) public view returns (bool) {
        return _owners[tokenId] != address(0) && !_licenses[tokenId].revoked;
    }

    function totalMinted() external view returns (uint256) {
        return _nextTokenId - 1;
    }

    /**
     * @notice Returns the ipfs:// URI of the license metadata document.
     * @dev Reverts for unknown tokens, and until the document is pinned, so an
     *      empty or dangling URI is never served.
     */
    function tokenURI(uint256 tokenId) external view returns (string memory) {
        if (_owners[tokenId] == address(0)) revert TokenDoesNotExist(tokenId);
        LicenseRecord storage record = _licenses[tokenId];
        if (!record.metadataSet) revert MetadataNotSet(tokenId);
        return string.concat("ipfs://", record.metadataCid);
    }

    function balanceOf(address account) external view returns (uint256) {
        if (account == address(0)) revert ZeroAddress();
        return _balances[account];
    }

    function ownerOf(uint256 tokenId) public view returns (address) {
        address tokenOwner = _owners[tokenId];
        if (tokenOwner == address(0)) revert TokenDoesNotExist(tokenId);
        return tokenOwner;
    }

    function getApproved(uint256 tokenId) external view existingToken(tokenId) returns (address) {
        return _tokenApprovals[tokenId];
    }

    function isApprovedForAll(address account, address operator) external view returns (bool) {
        return _operatorApprovals[account][operator];
    }

    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == 0x01ffc9a7 // ERC-165
            || interfaceId == 0x80ac58cd // ERC-721
            || interfaceId == 0x5b5e139f; // ERC-721 Metadata
    }

    // ------------------------------------------------------------- ERC-721 ops
    function approve(address to, uint256 tokenId) external {
        address tokenOwner = ownerOf(tokenId);
        if (msg.sender != tokenOwner && !_operatorApprovals[tokenOwner][msg.sender]) {
            revert NotAuthorized();
        }
        _tokenApprovals[tokenId] = to;
        emit Approval(tokenOwner, to, tokenId);
    }

    function setApprovalForAll(address operator, bool approved) external {
        if (operator == msg.sender) revert NotAuthorized();
        _operatorApprovals[msg.sender][operator] = approved;
        emit ApprovalForAll(msg.sender, operator, approved);
    }

    function transferFrom(address from, address to, uint256 tokenId) public {
        if (to == address(0)) revert ZeroAddress();
        ownerOf(tokenId);
        if (_owners[tokenId] != from) revert NotAuthorized();
        if (
            msg.sender != from && !_operatorApprovals[from][msg.sender]
                && msg.sender != _tokenApprovals[tokenId]
        ) {
            revert NotAuthorized();
        }

        delete _tokenApprovals[tokenId];
        unchecked {
            _balances[from] -= 1;
            _balances[to] += 1;
        }
        _owners[tokenId] = to;

        emit Transfer(from, to, tokenId);
        emit Approval(from, address(0), tokenId);
    }

    function safeTransferFrom(address from, address to, uint256 tokenId) external {
        safeTransferFrom(from, to, tokenId, "");
    }

    function safeTransferFrom(address from, address to, uint256 tokenId, bytes memory data) public {
        transferFrom(from, to, tokenId);
        if (to.code.length != 0 && !_isSafeRecipient(from, to, tokenId, data)) {
            revert UnsafeRecipient();
        }
    }

    // ---------------------------------------------------------------- internals
    function _mint(address to, uint256 tokenId) private {
        _owners[tokenId] = to;
        unchecked {
            _balances[to] += 1;
        }
        emit Transfer(address(0), to, tokenId);
    }

    function _isSafeRecipient(address from, address to, uint256 tokenId, bytes memory data)
        private
        returns (bool)
    {
        try IERC721Receiver(to).onERC721Received(msg.sender, from, tokenId, data) returns (
            bytes4 selector
        ) {
            return selector == IERC721Receiver.onERC721Received.selector;
        } catch {
            return false;
        }
    }
}

/// @dev Minimal receiver interface — the only external surface this contract needs.
interface IERC721Receiver {
    function onERC721Received(address operator, address from, uint256 tokenId, bytes calldata data)
        external
        returns (bytes4);
}
