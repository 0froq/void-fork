export function Pagination({
  page,
  totalPages,
  baseUrl,
}: {
  page: number;
  totalPages: number;
  baseUrl: string;
}) {
  if (totalPages <= 1) return <></>;
  return (
    <div class="pagination">
      {page > 1 ? (
        <a href={`${baseUrl}?page=${page - 1}`}>Previous</a>
      ) : (
        <span class="disabled">Previous</span>
      )}
      <span class="current">
        {page} / {totalPages}
      </span>
      {page < totalPages ? (
        <a href={`${baseUrl}?page=${page + 1}`}>Next</a>
      ) : (
        <span class="disabled">Next</span>
      )}
    </div>
  );
}
