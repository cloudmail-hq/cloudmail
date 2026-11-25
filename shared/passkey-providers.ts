/**
 * Passkey provider names by AAGUID, the authenticator model id a passkey
 * reports when it is created. Used to name a new passkey after where it is
 * kept ("Google Password Manager", "1Password", "YubiKey 5") instead of
 * "Passkey 2", and to show that provider in the passkey list.
 *
 * Names only, for display. An AAGUID is self-reported and is never trusted
 * for anything else. A passkey that reports all zeros (some browsers withhold
 * it) or an AAGUID missing here gets the generic name.
 *
 * Source: the community list at
 * github.com/passkeydeveloper/passkey-authenticator-aaguids (aaguid.json),
 * kept for naming passkeys in account settings. Trimmed to password managers,
 * platform authenticators and common security keys; a key's many model ids
 * share one family name. Refresh by hand when a popular provider is missing.
 */

const PROVIDERS: Readonly<Record<string, string>> = {
	"bada5566-a7aa-401f-bd96-45619a55120d": "1Password",
	"fbfc3007-154e-4ecc-8c0b-6e020557d7bd": "Apple Passwords",
	"a4a2d88e-9796-4356-9164-e2a5a8bd019c": "Avast Password Manager",
	"6bb49926-160a-4306-a100-4eb39ba6ac45": "AVG Password Manager",
	"e7db2bd3-f2fe-4d71-ad78-7e7aa166cfd1": "Avira Password Manager",
	"d548826e-79b4-db40-a3d8-11116f7e8349": "Bitwarden",
	"adce0002-35bc-c60a-648b-0b25f1f05503": "Chrome on Mac",
	"b5397666-4885-aa6b-cebf-e52262a439a2": "Chromium Browser",
	"531126d6-e717-415c-9320-3d9aa6981239": "Dashlane",
	"771b48fd-d3d4-4f74-9232-fc157ab0507a": "Edge on Mac",
	"f3809540-7f14-49c1-a8b3-8f813b225541": "Enpass",
	"12755c32-8ad1-46eb-881c-e0b38d848b09": "Feitian security key",
	"12ded745-4bed-47d4-abaa-e713f51d6393": "Feitian security key",
	"234cd403-35a2-4cc2-8015-77ea280c77f5": "Feitian security key",
	"260e3021-482d-442d-838c-7edfbe153b7e": "Feitian security key",
	"2bff89f2-323a-48fc-b7c8-9ff7fe87c07e": "Feitian security key",
	"2c0df832-92de-4be1-8412-88a8f074df4a": "Feitian security key",
	"39589099-9a75-49fc-afaa-801ca211c62a": "Feitian security key",
	"3e22415d-7fdf-4ea4-8a0c-dd60c4249b9d": "Feitian security key",
	"42df17de-06ba-4177-a2bb-6701be1380d6": "Feitian security key",
	"4c0cf95d-2f40-43b5-ba42-4c83a11c04ba": "Feitian security key",
	"77010bd7-212a-4fc9-b236-d2ca5e9d4084": "Feitian security key",
	"78ba3993-d784-4f44-8d6e-cc0a8ad5230e": "Feitian security key",
	"833b721a-ff5f-4d00-bb2e-bdda3ec01e29": "Feitian security key",
	"a02140b7-0cbd-42e1-a9b5-a39da2545114": "Feitian security key",
	"b6ede29c-3772-412c-8a78-539c1f4c62d2": "Feitian security key",
	"ee041bce-25e5-4cdb-8f86-897fd6418464": "Feitian security key",
	"ea9b8d66-4d01-1d21-3ce4-b6b48cb575d4": "Google Password Manager",
	"42b4fb4a-2866-43b2-9bf7-6c6669c2e5d3": "Google Titan Security Key",
	"dd4ec289-e01d-41c9-bb89-70fa845d4bf2": "Apple Passwords",
	"39a5647e-1853-446c-a1f6-a79bae9f5bc7": "IDmelon",
	"a10c6dd9-465e-4226-8198-c7c44b91c555": "Kaspersky Password Manager",
	"eaecdef2-1c31-5634-8639-f1cbd9c00a08": "KeePassDX",
	"fdb141b2-5d84-443e-8a35-4698c205a502": "KeePassXC",
	"0ea242b4-43c4-4a1b-8b17-dd6d0b6baec6": "Keeper",
	"b78a0a55-6ef8-d246-a042-ba0f6d55050c": "LastPass",
	"d3452668-01fd-4c12-926c-83a4204853aa": "Microsoft Password Manager",
	"2cd2f727-f6ca-44da-8f48-5c2e5da000a2": "Nitrokey 3",
	"b84e4048-15dc-4dd0-8640-f4f60813c8af": "NordPass",
	"fa37f553-f9b6-4adb-ac53-8bbb57ebdf0d": "Norton Password Manager",
	"50726f74-6f6e-5061-7373-50726f746f6e": "Proton Pass",
	"53414d53-554e-4700-0000-000000000000": "Samsung Pass",
	"d9be9d39-e6a6-4c28-a581-32b044d986e4": "Sticky Password Manager",
	"ab32f0c6-2239-afbb-c470-d2ef4e254db7": "Token2 security key",
	"eabb46cc-e241-80bf-ae9e-96fa6d2975cf": "Token2 security key",
	"08987058-cadc-4b81-b6e1-30de50dcbe96": "Windows Hello",
	"6028b017-b1d4-4c02-b4b3-afcdafc96bb2": "Windows Hello",
	"9ddd1817-af5a-4672-a2b9-3e3dd95000a9": "Windows Hello",
	"0bb43545-fd2c-4185-87dd-feb0b2916ace": "Yubico Security Key",
	"149a2021-8ef6-4133-96b8-81f8d5b7f1f5": "Yubico Security Key",
	"47ab2fb4-66ac-4184-9ae1-86be814012d5": "Yubico Security Key",
	"6d44ba9b-f6ec-2e49-b930-0c8fe920cb73": "Yubico Security Key",
	"72c6b72d-8512-4c66-8359-9d3d10d9222f": "Yubico Security Key",
	"9ff4cc65-6154-4fff-ba09-9e2af7882ad2": "Yubico Security Key",
	"a4e9fc6d-4cbe-4758-b8ba-37598bb5bbaa": "Yubico Security Key",
	"b7d3f68e-88a6-471e-9ecf-2df26d041ede": "Yubico Security Key",
	"b92c3f9a-c014-4056-887f-140a2501163b": "Yubico Security Key",
	"e77e3c64-05e3-428b-8824-0cbeb04b829d": "Yubico Security Key",
	"ed042a3a-4b22-4455-bb69-a267b652ae7e": "Yubico Security Key",
	"f8a011f3-8c0a-4d15-8006-17111f9edc7d": "Yubico Security Key",
	"03012cb7-4fb2-42e7-9e8d-a81f10e2a5e9": "YubiKey 5",
	"0a357157-9b18-4c8a-920e-d156e972b2f8": "YubiKey 5",
	"0ebd9f2c-f685-441c-8c3e-a02a234a840a": "YubiKey 5",
	"19083c3d-8383-4b18-bc03-8f1c9ab2fd1b": "YubiKey 5",
	"1ac71f64-468d-4fe0-bef1-0e5f2f551f18": "YubiKey 5",
	"20ac7a17-c814-4833-93fe-539f0d5e3389": "YubiKey 5",
	"24673149-6c86-42e7-98d9-433fb5b73296": "YubiKey 5",
	"2fc0579f-8113-47ea-b116-bb5a8db9202a": "YubiKey 5",
	"3a662962-c6d4-4023-bebb-98ae92e78e20": "YubiKey 5",
	"3aa78eb1-ddd8-46a8-a821-8f8ec57a7bd5": "YubiKey 5",
	"3b24bf49-1d45-4484-a917-13175df0867b": "YubiKey 5",
	"3ec9c8d3-a5a7-415b-a7b5-f1d606368d3f": "YubiKey 5",
	"41e39911-c669-4811-b860-c6ad0b411b96": "YubiKey 5",
	"4599062e-6926-4fe7-9566-9e8fb1aedaa0": "YubiKey 5",
	"4fc84f16-2545-4e53-b8fc-7bf4d7282a10": "YubiKey 5",
	"524de2de-982f-49b4-a769-2b5e3b73ad79": "YubiKey 5",
	"57f7de54-c807-4eab-b1c6-1c9be7984e92": "YubiKey 5",
	"662ef48a-95e2-4aaa-a6c1-5b9c40375824": "YubiKey 5",
	"6ab56fad-881f-4a43-acb2-0be065924522": "YubiKey 5",
	"73bb0cd4-e502-49b8-9c6f-b59445bf720b": "YubiKey 5",
	"79f3c8ba-9e35-484b-8f47-53a5a0f5c630": "YubiKey 5",
	"7b96457d-e3cd-432b-9ceb-c9fdd7ef7432": "YubiKey 5",
	"7dab85a5-d16d-4eaf-a7ef-4c1385b151c5": "YubiKey 5",
	"85203421-48f9-4355-9bc8-8a53846e5083": "YubiKey 5",
	"905b4cb4-ed6f-4da9-92fc-45e0d4e9b5c7": "YubiKey 5",
	"9a3f2abd-a73d-439c-9ee7-1b53a857eaa7": "YubiKey 5",
	"9eb7eabc-9db5-49a1-b6c3-555a802093f4": "YubiKey 5",
	"a02167b9-ae71-4ac7-9a07-06432ebb6f1c": "YubiKey 5",
	"a25342c0-3cdc-4414-8e46-f4807fca511c": "YubiKey 5",
	"b2c1a50b-dad8-4dc7-ba4d-0ce9597904bc": "YubiKey 5",
	"b90e7dc1-316e-4fee-a25a-56a666a670fe": "YubiKey 5",
	"c1f9a0bc-1dd2-404a-b27f-8e29047a43fd": "YubiKey 5",
	"c3479970-e58a-4f70-836f-853bf42fb063": "YubiKey 5",
	"c5ef55ff-ad9a-4b9f-b580-adebafe026d0": "YubiKey 5",
	"cb69481e-8ff7-4039-93ec-0a2729a154a8": "YubiKey 5",
	"d7781e5d-e353-46aa-afe2-3ca49f13332a": "YubiKey 5",
	"eb7ef748-cbe0-4b40-b8f6-07bd2d592d35": "YubiKey 5",
	"ee882879-721c-4913-9775-3dfcce97072a": "YubiKey 5",
	"f4ce5fc0-57d3-46f5-a736-efb7d5bc63b5": "YubiKey 5",
	"fa2b99dc-9e39-4257-8f92-4a30d23c4118": "YubiKey 5",
	"fcc0118f-cd45-435b-8da1-9782b2da0715": "YubiKey 5",
	"ff4dac45-ede8-4ec2-aced-cf66103f4335": "YubiKey 5",
	"34744913-4f57-4e6e-a527-e9ec3c4b94e6": "YubiKey Bio",
	"58276709-bb4b-4bb3-baf1-60eea99282a7": "YubiKey Bio",
	"6ec5cff2-a0f9-4169-945b-f33b563f7b99": "YubiKey Bio",
	"7409272d-1ff9-4e10-9fc9-ac0019c124fd": "YubiKey Bio",
	"7d1351a6-e097-4852-b8bf-c9ac5c9ce4a3": "YubiKey Bio",
	"83c47309-aabb-4108-8470-8be838b573cb": "YubiKey Bio",
	"8c39ee86-7f9a-4a95-9ba3-f6b097e5c2ee": "YubiKey Bio",
	"90636e1f-ef82-43bf-bdcf-5255f139d12f": "YubiKey Bio",
	"97e6a830-c952-4740-95fc-7c78dc97ce47": "YubiKey Bio",
	"9806a2c8-c0da-478e-b4ca-620005d34182": "YubiKey Bio",
	"9dd8d593-2213-438a-97f8-d6b813d51c27": "YubiKey Bio",
	"ad08c78a-4e41-49b9-86a2-ac15b06899e2": "YubiKey Bio",
	"add92433-0d69-4026-8166-29b25bce64e9": "YubiKey Bio",
	"ba0a9266-40d8-4048-9786-d710b5474752": "YubiKey Bio",
	"d8522d9f-575b-4866-88a9-ba99fa02f35b": "YubiKey Bio",
	"dc5e949d-f939-43b3-9877-a85c7186b753": "YubiKey Bio",
	"dd86a2da-86a0-4cbe-b462-4bd31f57bc6f": "YubiKey Bio",
	"b35a26b2-8f6e-4697-ab1d-d44db4da28c6": "Zoho Vault",
};

/** The provider's name for this AAGUID, or null when unknown or withheld. */
export function passkeyProviderName(aaguid: string | null | undefined): string | null {
	if (!aaguid) return null;
	return PROVIDERS[aaguid.trim().toLowerCase()] ?? null;
}

/**
 * Default name for a new passkey: the provider's name, numbered when the
 * account already has one by that name ("1Password", "1Password 2"), else
 * "Passkey N".
 */
export function defaultPasskeyName(aaguid: string | null | undefined, existingNames: readonly string[]): string {
	const taken = new Set(existingNames.map((n) => n.trim().toLowerCase()));
	const provider = passkeyProviderName(aaguid);
	if (provider) {
		if (!taken.has(provider.toLowerCase())) return provider;
		for (let n = 2; ; n++) {
			const name = `${provider} ${n}`;
			if (!taken.has(name.toLowerCase())) return name;
		}
	}
	for (let n = existingNames.length + 1; ; n++) {
		const name = `Passkey ${n}`;
		if (!taken.has(name.toLowerCase())) return name;
	}
}
