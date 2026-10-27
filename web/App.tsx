import { CenterMessage } from './components';
import { Link, usePath } from './router';
import { Editor } from './screens/Editor';
import { ProjectList } from './screens/ProjectList';
import { ResultPlaceholder } from './screens/ResultPlaceholder';

export function App() {
  const path = usePath();
  if (path === '/' || path === '') return <ProjectList />;
  const result = path.match(/^\/projects\/([0-9a-f-]{36})\/result\/?$/);
  if (result) return <ResultPlaceholder projectId={result[1]!} />;
  const edit = path.match(/^\/projects\/([0-9a-f-]{36})\/?$/);
  if (edit) return <Editor key={edit[1]} projectId={edit[1]!} />;
  return (
    <CenterMessage title="페이지를 찾을 수 없어요">
      <Link to="/" className="btn btn-primary">
        프로젝트 목록으로
      </Link>
    </CenterMessage>
  );
}
