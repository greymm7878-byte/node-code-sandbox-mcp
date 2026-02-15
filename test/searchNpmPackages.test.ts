import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
  type Mock,
} from 'vitest';
import searchNpmPackages, {
  PackageDetails,
  SearchNpmPackagesToolSchemaType,
} from '../src/tools/searchNpmPackages.ts';
import { NpmRegistry } from 'npm-registry-sdk';
import {
  textContent,
  type McpContentText,
  type McpResponse,
} from '../src/types.ts';

vi.mock('npm-registry-sdk');

describe('searchNpmPackages', () => {
  let searchMock: ReturnType<typeof vi.fn>;
  let getPackageMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    searchMock = vi.fn();
    getPackageMock = vi.fn();

    // Configure the mocked NpmsIO constructor to return our specific mock methods
    (NpmRegistry as Mock).mockImplementation(() => {
      return {
        search: searchMock,
        getPackage: getPackageMock,
      };
    });
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  it('should return packages with their details when search is successful', async () => {
    const mockSearchResults = {
      total: 2,
      objects: [
        {
          package: { name: 'package1' },
          score: { detail: { popularity: 1 } },
        },
        {
          package: { name: 'package2' },
          score: { detail: { popularity: 0.5 } },
        },
      ],
    };

    const mockPackageInfos = [
      {
        name: 'package1',
        description: 'Test package 1',
        readme: 'Package 1 readme content',
      },
      {
        name: 'package2',
        description: 'Test package 2',
        readme: 'Package 2 readme content',
      },
    ];

    searchMock.mockResolvedValue(mockSearchResults);
    getPackageMock.mockImplementation((pkg) =>
      Promise.resolve(mockPackageInfos.find((p) => p.name === pkg))
    );

    const result = await searchNpmPackages({
      searchTerm: 'test-package',
    });

    expect(searchMock).toHaveBeenCalledWith('test-package', {
      qualifiers: undefined,
    });
    expect(getPackageMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse((result.content[0] as McpContentText).text)).toEqual([
      {
        name: 'package1',
        description: 'Test package 1',
        readmeSnippet: 'Package 1 readme content',
      },
      {
        name: 'package2',
        description: 'Test package 2',
        readmeSnippet: 'Package 2 readme content',
      },
    ]);
  });

  it('should return "No packages found" when search returns no results', async () => {
    searchMock.mockResolvedValue({ total: 0, objects: [] });

    const result = await searchNpmPackages({
      searchTerm: 'nonexistent-package',
    });

    expect(searchMock).toHaveBeenCalledWith('nonexistent-package', {
      qualifiers: undefined,
    });
    expect(getPackageMock).not.toHaveBeenCalled();
    expect((result.content[0] as McpContentText).text).toBe(
      'No packages found.'
    );
  });

  it('should apply search qualifiers when provided', async () => {
    const mockSearchResults = {
      total: 1,
      objects: [
        {
          package: { name: 'qualified-package' },
          score: { detail: { popularity: 1 } },
        },
      ],
    };

    const mockPackageInfo = {
      name: 'qualified-package',
      description: 'Qualified package',
      readme: 'Qualified package readme',
    };

    searchMock.mockResolvedValue(mockSearchResults);
    getPackageMock.mockResolvedValue(mockPackageInfo);

    const qualifiers = {
      author: 'test-author',
      keywords: 'test',
    };

    const result = await searchNpmPackages({
      searchTerm: 'test-package',
      qualifiers,
    });

    expect(searchMock).toHaveBeenCalledWith('test-package', { qualifiers });
    expect(getPackageMock).toHaveBeenCalledWith('qualified-package');
    expect(JSON.parse((result.content[0] as McpContentText).text)).toEqual([
      {
        name: 'qualified-package',
        description: 'Qualified package',
        readmeSnippet: 'Qualified package readme',
      },
    ]);
  });

  it('should handle packages with missing description or readme', async () => {
    const mockSearchResults = {
      total: 1,
      objects: [
        {
          package: { name: 'incomplete-package' },
          score: { detail: { popularity: 1 } },
        },
      ],
    };

    const mockPackageInfo = {
      name: 'incomplete-package',
      description: undefined,
      readme: undefined,
    };

    searchMock.mockResolvedValue(mockSearchResults);
    getPackageMock.mockResolvedValue(mockPackageInfo);

    const result = await searchNpmPackages({
      searchTerm: 'incomplete-package',
    });

    expect(JSON.parse((result.content[0] as McpContentText).text)).toEqual([
      {
        name: 'incomplete-package',
        description: 'No description available.',
        readmeSnippet: 'README not available.',
      },
    ]);
  });

  it('should handle search errors gracefully', async () => {
    const error = new Error('Search failed');
    searchMock.mockRejectedValue(error);

    const result = await searchNpmPackages({
      searchTerm: 'test-package',
    });

    expect(result).toEqual({
      content: [
        {
          text: 'Failed to search npm packages for "test-package". Error: Search failed',
          type: 'text',
        },
      ],
      isError: true,
    });
    expect(getPackageMock).not.toHaveBeenCalled();
  });
});
export class SearchNpmPackagesTool {
  private readonly registry: NpmRegistry;
  private readonly maxResults = 5;
  private readonly maxReadmeLength = 500;

  constructor() {
    this.registry = new NpmRegistry();
  }

  /**
   * Searches for npm packages based on the provided search term and qualifiers
   * @param {SearchNpmPackagesToolSchemaType} params - Search parameters including search term and optional qualifiers
   * @returns {Promise<McpResponse>} A response containing the search results or an error message
   */
  public async searchPackages({
    searchTerm,
    qualifiers,
  }: SearchNpmPackagesToolSchemaType): Promise<McpResponse> {
    const searchResults = await this.registry.search(searchTerm, {
      qualifiers,
    });

    if (!searchResults.total) {
      return {
        content: [textContent('No packages found.')],
      };
    }

    const packages = searchResults.objects
      .sort((a, b) => b.score.detail.popularity - a.score.detail.popularity)
      .slice(0, this.maxResults)
      .map((result) => result.package.name);

    const packagesInfos = await this.getPackagesDetails(packages);

    return {
      content: [textContent(JSON.stringify(packagesInfos, null, 2))],
    };
  }

  /**
   * Retrieves detailed information for multiple packages
   * @param {string[]} packages - Array of package names to get details for
   * @returns {Promise<PackageDetails[]>} Array of package details
   * @private
   */
  private async getPackagesDetails(
    packages: string[]
  ): Promise<PackageDetails[]> {
    const multiPackageInfo: PackageInfo[] = await Promise.all(
      packages.map((pkg) => this.registry.getPackage(pkg))
    );

    const packagesDetails: PackageDetails[] = [];

    for (const packageInfo of Object.values(multiPackageInfo)) {
      packagesDetails.push({
        name: packageInfo.name,
        description: packageInfo.description || 'No description available.',
        readmeSnippet: this.extractReadmeSnippet(packageInfo.readme),
      });
    }

    return packagesDetails;
  }

  /**
   * Extracts a snippet from a package's README file
   * @param {string | undefined} readme - The full README content
   * @returns {string} A truncated snippet of the README or a default message if README is not available
   * @private
   */
  private extractReadmeSnippet(readme: string | undefined): string {
    if (!readme) {
      return 'README not available.';
    }

    const snippet = readme.substring(0, this.maxReadmeLength);
    return snippet.length === this.maxReadmeLength ? snippet + '...' : snippet;
  }
}
